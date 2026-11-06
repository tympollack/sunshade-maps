/** Display formatters for the Inspector drawer. `null` always renders as "Not recorded". */

export const NOT_RECORDED = "Not recorded";

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export function formatUsd(value: number | null): string {
  return value === null ? NOT_RECORDED : USD.format(value);
}

export function formatAcres(value: number | null): string {
  // CAGIS stores 0 for parcels with no deeded acreage; that is "unrecorded", not 0 acres.
  return value === null || value <= 0 ? NOT_RECORDED : `${value.toFixed(value < 1 ? 3 : 2)} ac`;
}

export function formatBoolean(value: boolean | null): string {
  return value === null ? NOT_RECORDED : value ? "Yes" : "No";
}

/** `2019-05-17` → locale date; invalid or missing → "Not recorded". */
export function formatIsoDate(value: string | null): string {
  if (!value) return NOT_RECORDED;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? NOT_RECORDED : d.toLocaleDateString("en-US", { timeZone: "UTC" });
}

export function formatSigned(value: number, digits = 2): string {
  return `${value > 0 ? "+" : ""}${value.toFixed(digits)}`;
}
