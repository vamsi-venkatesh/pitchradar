import type { ClientProfile } from "./types";

export const clientProfile: ClientProfile = {
  homeRegion: "Brandenburg",
  normalDays: [5, 6, 0],
  optionalThursday: true,
  preferredMaxTravelMinutes: 8 * 60,
  exceptionalMaxTravelMinutes: 10 * 60,
  menu: [
    { name: "Klassiker süß", priceEur: 7 },
    { name: "Kräuter", priceEur: 6 },
    { name: "Zucker & Zimt", priceEur: 6 },
    { name: "Variante A", priceEur: 8, confirmationRequired: true },
    { name: "Variante B", priceEur: 8, confirmationRequired: true },
    { name: "Schinken", priceEur: 8 },
    { name: "Wurst", priceEur: 8 },
    { name: "Komplett", priceEur: 10, confirmationRequired: true }
  ],
  operatingInputs: {}
};

export const missingProfileInputs = [
  "Exact postcode / starting address",
  "Portions per hour and per day",
  "Food, labour and travel costs",
  "Truck dimensions and pitch footprint",
  "Power, water and gas requirements",
  "Maximum pitch fee",
  "Minimum revenue or margin",
  "Permits, insurance and hygiene documents",
  "Photos and existing application material"
];
