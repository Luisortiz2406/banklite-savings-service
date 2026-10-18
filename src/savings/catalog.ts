/**
 * Condiciones de ahorro de Banklite (las mismas de la versión simulada).
 */
export const POCKET_RATE = 0.09; // 9% efectivo anual (bolsillos; las metas no rentan)
export const CDT_MIN = 500_000;
export const CDT_TAX = 0.04; // retención en la fuente sobre los intereses
export const CDT_TERMS = [
  { days: 30, rate: 0.085 },
  { days: 60, rate: 0.09 },
  { days: 90, rate: 0.095 },
  { days: 180, rate: 0.102 },
  { days: 360, rate: 0.11 },
];

export const MIN_MOVE = 1_000; // valor mínimo para agregar o sacar
export const MAX_POCKETS = 8;
export const MAX_GOALS = 10;
export const GOAL_MIN_TARGET = 10_000;

export const POCKET_ICONS = ['general', 'viaje', 'casa', 'carro', 'estudio', 'regalo', 'emergencia'];
export const GOAL_ICONS = ['viaje', 'casa', 'carro', 'estudio', 'tecnologia', 'emergencia', 'regalo', 'otro'];

/**
 * Tasas y topes de ahorro que muestran el frontend y Banki (GET /savings/catalog,
 * público) y la vista de Bolsillos y CDT. Son la única fuente de estas cifras.
 */
export function savingsCatalog() {
  return {
    pocketRate: POCKET_RATE,
    cdtMin: CDT_MIN,
    cdtTax: CDT_TAX,
    cdtTerms: CDT_TERMS,
    minMove: MIN_MOVE,
    maxPockets: MAX_POCKETS,
    maxGoals: MAX_GOALS,
    goalMinTarget: GOAL_MIN_TARGET,
  };
}

export const DAY_MS = 86_400_000;

/** Interés compuesto con tasa efectiva anual, redondeado a centavos. */
export function interestFor(amount: number, rate: number, days: number): number {
  if (amount <= 0 || days <= 0 || rate <= 0) return 0;
  return Math.floor(amount * (Math.pow(1 + rate, days / 365) - 1) * 100) / 100;
}

export function cdtResult(amount: number, rate: number, days: number) {
  const gross = interestFor(amount, rate, days);
  const tax = Math.round(gross * CDT_TAX * 100) / 100;
  const net = Math.round((gross - tax) * 100) / 100;
  return { gross, tax, net, total: Math.round((amount + net) * 100) / 100 };
}
