import { rupees } from "../core/money.js";
import type { CatalogItem } from "../core/types.js";

export const MERCHANT_ID = "kirana-fresh";
export const MERCHANT_NAME = "Kirana Fresh";

/**
 * An agent-readable catalog: typed fields and machine-comparable attributes,
 * so a buyer agent can filter and price without scraping a storefront.
 */
export const CATALOG: CatalogItem[] = [
  { sku: "GRC-ATTA-5KG",   title: "Whole wheat atta, 5 kg",        category: "groceries",  unitPaise: rupees(285), taxBps: 500,  inStock: 120, attributes: { brand: "Annapurna", weightKg: 5, organic: false } },
  { sku: "GRC-RICE-5KG",   title: "Sona masoori rice, 5 kg",       category: "groceries",  unitPaise: rupees(410), taxBps: 500,  inStock: 80,  attributes: { brand: "Daawat", weightKg: 5, organic: false } },
  { sku: "GRC-DAL-1KG",    title: "Toor dal, 1 kg",                category: "groceries",  unitPaise: rupees(178), taxBps: 500,  inStock: 200, attributes: { brand: "Tata Sampann", weightKg: 1, organic: false } },
  { sku: "GRC-OIL-1L",     title: "Cold-pressed groundnut oil, 1 L", category: "groceries", unitPaise: rupees(320), taxBps: 500, inStock: 60,  attributes: { brand: "Gramiyum", volumeL: 1, organic: true } },
  { sku: "GRC-TEA-500G",   title: "Assam CTC tea, 500 g",          category: "groceries",  unitPaise: rupees(245), taxBps: 500,  inStock: 90,  attributes: { brand: "Wagh Bakri", weightKg: 0.5, organic: false } },
  { sku: "HHD-DETRG-2KG",  title: "Detergent powder, 2 kg",        category: "household",  unitPaise: rupees(299), taxBps: 1800, inStock: 75,  attributes: { brand: "Surf Excel", weightKg: 2 } },
  { sku: "HHD-DISH-750ML", title: "Dishwash liquid, 750 ml",       category: "household",  unitPaise: rupees(189), taxBps: 1800, inStock: 140, attributes: { brand: "Vim", volumeL: 0.75 } },
  { sku: "PCR-SOAP-4X125", title: "Bathing soap, pack of 4",       category: "personal_care", unitPaise: rupees(196), taxBps: 1800, inStock: 160, attributes: { brand: "Mysore Sandal", count: 4 } },
  { sku: "ELC-KETTLE-1L",  title: "Electric kettle, 1 L",          category: "electronics", unitPaise: rupees(1_299), taxBps: 1800, inStock: 25, attributes: { brand: "Pigeon", warrantyMonths: 12 } },
  { sku: "ELC-MIXER-750W", title: "Mixer grinder, 750 W",          category: "electronics", unitPaise: rupees(3_499), taxBps: 1800, inStock: 12, attributes: { brand: "Preethi", warrantyMonths: 24 } },
];

export const bySku = (sku: string): CatalogItem | undefined => CATALOG.find((i) => i.sku === sku);

export interface SearchQuery {
  q?: string;
  category?: string;
  maxUnitPaise?: number;
  limit?: number;
}

export function search(query: SearchQuery): CatalogItem[] {
  const needle = query.q?.toLowerCase().trim();
  return CATALOG.filter((i) => {
    if (query.category && i.category !== query.category) return false;
    if (query.maxUnitPaise !== undefined && i.unitPaise > query.maxUnitPaise) return false;
    if (needle && !`${i.title} ${i.sku} ${i.category}`.toLowerCase().includes(needle)) return false;
    return i.inStock > 0;
  }).slice(0, query.limit ?? 20);
}
