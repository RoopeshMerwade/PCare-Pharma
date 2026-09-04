/* Pharmacy-aware chart layer: ui/charts primitives + ₹ formatting + the
   fixed entity→slot colour map. Route components compose these; the raw
   primitives stay in ui/charts. */

export {
  PAYMENT_SERIES,
  REVENUE_COLOR,
  num,
  zeroFillDays,
  deltaVs,
  shareOf,
  bucketByMonth,
  monthLabel,
  truncate,
} from './series';
export { default as StatTile } from './StatTile';
export { default as RevenueTrendCard } from './RevenueTrendCard';
export { default as PaymentMixCard } from './PaymentMixCard';
export { default as PaymentTrendCard } from './PaymentTrendCard';
export { default as StockHealthCard } from './StockHealthCard';
export { default as MarginLeadersCard } from './MarginLeadersCard';
export { default as TopMedicinesCard } from './TopMedicinesCard';
export { default as PurchaseFlowCard } from './PurchaseFlowCard';
