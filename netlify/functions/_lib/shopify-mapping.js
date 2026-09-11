// Shared Shopify order → rental mapping, used by BOTH shopify-sync.js
// (manual/polling sync) and shopify-webhook.js (real-time push). Kept in
// exactly one place on purpose — this logic was built and validated
// against seven real orders across every current product (see git
// history / README for specifics: typo'd property suffixes, a compact
// date format, multi-item orders for one person, "2 for 3" pricing).
// A second copy of this logic WILL drift and silently reintroduce bugs
// that were already found and fixed — that's exactly what happened with
// an earlier draft of the webhook, which is why this file exists.

"use strict";

const KNOWN_BASE_KEYS = [
  "first-name", "last-name", "gender", "age", "ability", "shoe-size",
  "shoe-size-type", "height-ft", "height-in", "weight", "pickup-date",
  "tod-pickup", "return-agreement", "liab-agree", "birthday",
  "helmet-size", "foot-width", "stance"
];

function isRentalLineItem(li, keyword) {
  const t = ((li.title || "") + " " + (li.sku || "")).toLowerCase();
  return t.includes(keyword);
}

// Strips a trailing "-xxxx" suffix token and checks the result against
// KNOWN_BASE_KEYS — robust to suffix typos (e.g. real data had
// "liab-agree-SRSR" where every sibling property used "-SRSP").
function normalizeKey(rawName) {
  const key = (rawName || "").toLowerCase().replace(/_copy$/, "");
  if (KNOWN_BASE_KEYS.includes(key)) return key;
  const stripped = key.replace(/-[a-z0-9]+$/, "");
  if (KNOWN_BASE_KEYS.includes(stripped)) return stripped;
  return key;
}

function normalizeProps(properties) {
  const out = {};
  (properties || []).forEach((p) => { out[normalizeKey(p.name)] = p.value; });
  return out;
}

function numOrNull(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

// Handles both "2026-03-19" and the compact "20260318" format seen in
// one real order. Always returns a UTC-noon Date to avoid timezone rollback.
function parseFlexibleDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  let m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

// Returns YYYY-MM-DD string (UTC) for reliable date comparisons.
function toISODate(raw) {
  const dt = parseFlexibleDate(raw);
  if (!dt) return null;
  const yr  = dt.getUTCFullYear();
  const mo  = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const day = String(dt.getUTCDate()).padStart(2, "0");
  return `${yr}-${mo}-${day}`;
}

// Returns display string "Apr 7" for the UI.
function fmtDate(raw) {
  const dt = parseFlexibleDate(raw);
  if (!dt) return raw || null;
  return dt.toLocaleDateString("en-CA", { timeZone: "UTC", month: "short", day: "numeric" });
}

// Add N calendar days to a YYYY-MM-DD string, returns YYYY-MM-DD.
function addDays(isoDate, n) {
  if (!isoDate) return null;
  const [yr, mo, dy] = isoDate.split("-").map(Number);
  const d = new Date(Date.UTC(yr, mo - 1, dy + n));
  return [
    d.getUTCFullYear(),
    String(d.getUTCMonth() + 1).padStart(2, "0"),
    String(d.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

// "2 for 3" promo pricing is read as "3 total calendar days".
// A 1-day rental starts and ends on the same date (endDate = startDate + 0).
// A 3-day rental Dec 1 ends Dec 3 (endDate = startDate + 2).
function parseDaysFromVariant(lineItem) {
  const vt = (lineItem.variant_title || "").toLowerCase();
  let m = /(\d+)\s*for\s*(\d+)/.exec(vt);
  if (m) return Math.max(1, parseInt(m[2], 10));
  m = /(\d+)\s*day/.exec(vt);
  if (m) return Math.max(1, parseInt(m[1], 10));
  return 1;
}

function abilityToSkierType(ability) {
  if (/advanc|expert/i.test(ability)) return "Type III (Advanced/Aggressive)";
  if (/interm/i.test(ability)) return "Type II (Intermediate)";
  return "Type I (Beginner/Cautious)";
}

// Groups an order's rental line items by (first + last name) so one
// person renting multiple items (e.g. a snowboard + a helmet as separate
// line items) becomes one rental record, not two disconnected ones.
function groupLineItemsByPerson(rentalLines) {
  const order = [];
  const groups = {};
  rentalLines.forEach((li) => {
    const props = normalizeProps(li.properties || []);
    const first = props["first-name"] || "";
    const last  = props["last-name"]  || "";
    const key   = (first + " " + last).trim().toLowerCase() || ("li-" + li.id);
    if (!groups[key]) { groups[key] = []; order.push(key); }
    groups[key].push({ lineItem: li, props });
  });
  return order.map((key) => groups[key]);
}

function mapGroupToRental(order, group) {
  const primary  = group.find((g) => g.props["weight"] !== undefined) || group[0];
  const props    = primary.props;
  const customer = order.customer         || {};
  const shipping = order.shipping_address || {};
  const billing  = order.billing_address  || {};

  const firstName = props["first-name"] || customer.first_name || billing.first_name || "";
  const lastName  = props["last-name"]  || customer.last_name  || billing.last_name  || "";
  const name      = (firstName + " " + lastName).trim() || order.email || "Shopify Customer";

  const pkg       = primary.lineItem.title || "Rental";
  const equipment = group.map((g) => g.lineItem.title || "Rental");
  const isSnow    = equipment.some((t) => t.toLowerCase().includes("snowboard"));

  const ability      = props["ability"] || "";
  const waiverAgreed = !!(props["liab-agree"] && props["return-agreement"]);

  const noteParts = [];
  if (order.note) noteParts.push(order.note);
  group.forEach((g) => {
    if (g.props["helmet-size"]) {
      noteParts.push((g.lineItem.title || "Item") + " — helmet size " + g.props["helmet-size"]);
    }
  });

  // ── Dates ───────────────────────────────────────────────────────────────
  // startISO: YYYY-MM-DD used for date comparisons (never null if we have any date)
  // startDate: "Apr 7" display string for the UI
  // days: from variant title ("2 for 3" → 3, "1 day" → 1, default 1)
  // endISO: startISO + (days - 1) — a 1-day rental ends on the same day it starts;
  //         a 3-day rental Dec 1 ends Dec 3.
  // endDate: "Apr 9" display string
  //
  // Both startISO and endISO are stored in Supabase (start_iso, end_iso columns).
  // The dashboard uses these ISO columns for all date comparisons — never the
  // display strings — so timezone bugs and null-end-date issues can't occur.

  const rawStart = props["pickup-date"] || order.created_at || null;
  const startISO = toISODate(rawStart);
  const startDate = fmtDate(rawStart);

  const days   = parseDaysFromVariant(primary.lineItem);
  const endISO  = startISO ? addDays(startISO, days - 1) : null;
  const endDate = endISO ? fmtDate(endISO) : null;

  return {
    id:               primary.lineItem.id,
    firstName,
    lastName,
    name,
    package:          pkg,
    status:           "setup",
    order:            order.name,
    isShopify:        true,
    shopifyOrderId:   String(order.id),
    shopifyLineItemId:String(primary.lineItem.id),
    startDate,   // display "Apr 7"
    endDate,     // display "Apr 9"  ← was hardcoded null — THIS WAS THE BUG
    startISO,    // "2026-04-07" for comparisons
    endISO,      // "2026-04-09" for comparisons
    days,
    phone:   customer.phone || shipping.phone || billing.phone || "",
    email:   order.email    || customer.email || "",
    waiver:      waiverAgreed,
    isMinor:     false,
    isReturning: (customer.orders_count || 0) > 1,
    isOverdue:   false,
    din:      null,
    weight:   numOrNull(props["weight"]),
    heightFt: numOrNull(props["height-ft"]),
    heightIn: numOrNull(props["height-in"]),
    shoe:     numOrNull(props["shoe-size"]),
    bsl:      null,
    age:      numOrNull(props["age"]),
    experience: ability || "Beginner",
    skierType:  abilityToSkierType(ability),
    rentalType: isSnow ? "Snowboard" : "Ski",
    equipment,
    notes: noteParts.join(" · "),
  };
}

function mapOrderToRentals(order, keyword) {
  const rentalLines = (order.line_items || []).filter((li) => isRentalLineItem(li, keyword));
  const groups = groupLineItemsByPerson(rentalLines);
  return groups.map((g) => mapGroupToRental(order, g));
}

module.exports = { mapOrderToRentals };
