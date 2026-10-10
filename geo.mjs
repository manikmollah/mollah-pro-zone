/**
 * Geo profile: country -> timezone / locale / approximate location.
 *
 * Used to make the machine look like it really sits in the exit country:
 *   - Windows timezone is switched with tzutil (and restored on disconnect)
 *   - the app window is launched with a matching language + timezone
 *   - the UI reports the spoofed locale next to the exit node
 *
 * The map is intentionally broad and falls back to UTC when a country is unknown,
 * so an unmapped country degrades gracefully instead of breaking the connection.
 */

export const GEO = {
  AE: { tz: 'Asia/Dubai', locale: 'ar-AE', lat: 24.4539, lon: 54.3773 },
  AR: { tz: 'America/Argentina/Buenos_Aires', locale: 'es-AR', lat: -34.6037, lon: -58.3816 },
  AT: { tz: 'Europe/Vienna', locale: 'de-AT', lat: 48.2082, lon: 16.3738 },
  AU: { tz: 'Australia/Sydney', locale: 'en-AU', lat: -33.8688, lon: 151.2093 },
  BA: { tz: 'Europe/Sarajevo', locale: 'bs-BA', lat: 43.8563, lon: 18.4131 },
  BD: { tz: 'Asia/Dhaka', locale: 'bn-BD', lat: 23.8103, lon: 90.4125 },
  BE: { tz: 'Europe/Brussels', locale: 'nl-BE', lat: 50.8503, lon: 4.3517 },
  BG: { tz: 'Europe/Sofia', locale: 'bg-BG', lat: 42.6977, lon: 23.3219 },
  BR: { tz: 'America/Sao_Paulo', locale: 'pt-BR', lat: -23.5505, lon: -46.6333 },
  CA: { tz: 'America/Toronto', locale: 'en-CA', lat: 43.6532, lon: -79.3832 },
  CH: { tz: 'Europe/Zurich', locale: 'de-CH', lat: 47.3769, lon: 8.5417 },
  CL: { tz: 'America/Santiago', locale: 'es-CL', lat: -33.4489, lon: -70.6693 },
  CN: { tz: 'Asia/Shanghai', locale: 'zh-CN', lat: 31.2304, lon: 121.4737 },
  CO: { tz: 'America/Bogota', locale: 'es-CO', lat: 4.711, lon: -74.0721 },
  CR: { tz: 'America/Costa_Rica', locale: 'es-CR', lat: 9.9281, lon: -84.0907 },
  CY: { tz: 'Asia/Nicosia', locale: 'el-CY', lat: 35.1856, lon: 33.3823 },
  CZ: { tz: 'Europe/Prague', locale: 'cs-CZ', lat: 50.0755, lon: 14.4378 },
  DE: { tz: 'Europe/Berlin', locale: 'de-DE', lat: 50.1109, lon: 8.6821 },
  DK: { tz: 'Europe/Copenhagen', locale: 'da-DK', lat: 55.6761, lon: 12.5683 },
  DO: { tz: 'America/Santo_Domingo', locale: 'es-DO', lat: 18.4861, lon: -69.9312 },
  EC: { tz: 'America/Guayaquil', locale: 'es-EC', lat: -0.1807, lon: -78.4678 },
  EE: { tz: 'Europe/Tallinn', locale: 'et-EE', lat: 59.437, lon: 24.7536 },
  EG: { tz: 'Africa/Cairo', locale: 'ar-EG', lat: 30.0444, lon: 31.2357 },
  ES: { tz: 'Europe/Madrid', locale: 'es-ES', lat: 40.4168, lon: -3.7038 },
  FI: { tz: 'Europe/Helsinki', locale: 'fi-FI', lat: 60.1699, lon: 24.9384 },
  FR: { tz: 'Europe/Paris', locale: 'fr-FR', lat: 48.8566, lon: 2.3522 },
  GB: { tz: 'Europe/London', locale: 'en-GB', lat: 51.5074, lon: -0.1278 },
  GR: { tz: 'Europe/Athens', locale: 'el-GR', lat: 37.9838, lon: 23.7275 },
  HK: { tz: 'Asia/Hong_Kong', locale: 'zh-HK', lat: 22.3193, lon: 114.1694 },
  HR: { tz: 'Europe/Zagreb', locale: 'hr-HR', lat: 45.815, lon: 15.9819 },
  HU: { tz: 'Europe/Budapest', locale: 'hu-HU', lat: 47.4979, lon: 19.0402 },
  ID: { tz: 'Asia/Jakarta', locale: 'id-ID', lat: -6.2088, lon: 106.8456 },
  IE: { tz: 'Europe/Dublin', locale: 'en-IE', lat: 53.3498, lon: -6.2603 },
  IL: { tz: 'Asia/Jerusalem', locale: 'he-IL', lat: 32.0853, lon: 34.7818 },
  IN: { tz: 'Asia/Kolkata', locale: 'en-IN', lat: 19.076, lon: 72.8777 },
  IT: { tz: 'Europe/Rome', locale: 'it-IT', lat: 41.9028, lon: 12.4964 },
  JP: { tz: 'Asia/Tokyo', locale: 'ja-JP', lat: 35.6762, lon: 139.6503 },
  KE: { tz: 'Africa/Nairobi', locale: 'en-KE', lat: -1.2921, lon: 36.8219 },
  KR: { tz: 'Asia/Seoul', locale: 'ko-KR', lat: 37.5665, lon: 126.978 },
  KZ: { tz: 'Asia/Almaty', locale: 'kk-KZ', lat: 43.222, lon: 76.8512 },
  LT: { tz: 'Europe/Vilnius', locale: 'lt-LT', lat: 54.6872, lon: 25.2797 },
  LU: { tz: 'Europe/Luxembourg', locale: 'fr-LU', lat: 49.6116, lon: 6.1319 },
  LV: { tz: 'Europe/Riga', locale: 'lv-LV', lat: 56.9496, lon: 24.1052 },
  MA: { tz: 'Africa/Casablanca', locale: 'ar-MA', lat: 33.5731, lon: -7.5898 },
  MD: { tz: 'Europe/Chisinau', locale: 'ro-MD', lat: 47.0105, lon: 28.8638 },
  MX: { tz: 'America/Mexico_City', locale: 'es-MX', lat: 19.4326, lon: -99.1332 },
  MY: { tz: 'Asia/Kuala_Lumpur', locale: 'ms-MY', lat: 3.139, lon: 101.6869 },
  NG: { tz: 'Africa/Lagos', locale: 'en-NG', lat: 6.5244, lon: 3.3792 },
  NL: { tz: 'Europe/Amsterdam', locale: 'nl-NL', lat: 52.3676, lon: 4.9041 },
  NO: { tz: 'Europe/Oslo', locale: 'nb-NO', lat: 59.9139, lon: 10.7522 },
  NZ: { tz: 'Pacific/Auckland', locale: 'en-NZ', lat: -36.8485, lon: 174.7633 },
  PE: { tz: 'America/Lima', locale: 'es-PE', lat: -12.0464, lon: -77.0428 },
  PH: { tz: 'Asia/Manila', locale: 'en-PH', lat: 14.5995, lon: 120.9842 },
  PK: { tz: 'Asia/Karachi', locale: 'en-PK', lat: 24.8607, lon: 67.0011 },
  PL: { tz: 'Europe/Warsaw', locale: 'pl-PL', lat: 52.2297, lon: 21.0122 },
  PT: { tz: 'Europe/Lisbon', locale: 'pt-PT', lat: 38.7223, lon: -9.1393 },
  RO: { tz: 'Europe/Bucharest', locale: 'ro-RO', lat: 44.4268, lon: 26.1025 },
  RS: { tz: 'Europe/Belgrade', locale: 'sr-RS', lat: 44.7866, lon: 20.4489 },
  RU: { tz: 'Europe/Moscow', locale: 'ru-RU', lat: 55.7558, lon: 37.6173 },
  SA: { tz: 'Asia/Riyadh', locale: 'ar-SA', lat: 24.7136, lon: 46.6753 },
  SE: { tz: 'Europe/Stockholm', locale: 'sv-SE', lat: 59.3293, lon: 18.0686 },
  SG: { tz: 'Asia/Singapore', locale: 'en-SG', lat: 1.3521, lon: 103.8198 },
  SI: { tz: 'Europe/Ljubljana', locale: 'sl-SI', lat: 46.0569, lon: 14.5058 },
  SK: { tz: 'Europe/Bratislava', locale: 'sk-SK', lat: 48.1486, lon: 17.1077 },
  TH: { tz: 'Asia/Bangkok', locale: 'th-TH', lat: 13.7563, lon: 100.5018 },
  TR: { tz: 'Europe/Istanbul', locale: 'tr-TR', lat: 41.0082, lon: 28.9784 },
  TW: { tz: 'Asia/Taipei', locale: 'zh-TW', lat: 25.033, lon: 121.5654 },
  UA: { tz: 'Europe/Kyiv', locale: 'uk-UA', lat: 50.4501, lon: 30.5234 },
  US: { tz: 'America/New_York', locale: 'en-US', lat: 40.7128, lon: -74.006 },
  VN: { tz: 'Asia/Ho_Chi_Minh', locale: 'vi-VN', lat: 10.8231, lon: 106.6297 },
  ZA: { tz: 'Africa/Johannesburg', locale: 'en-ZA', lat: -26.2041, lon: 28.0473 },
};

/** UTC is always a safe fallback. */
export const FALLBACK = { tz: 'UTC', locale: 'en-US', lat: 0, lon: 0 };

export function geoFor(cc) {
  if (!cc) return { ...FALLBACK };
  return GEO[String(cc).toUpperCase()] ?? { ...FALLBACK };
}

/** Coarse region label, handy for the UI and for grouping in the server list. */
export function regionFor(cc) {
  const c = String(cc || '').toUpperCase();
  if (['BD', 'IN', 'PK', 'LK', 'NP', 'BT', 'MV', 'AF'].includes(c)) return 'South Asia';
  if (['SG', 'MY', 'ID', 'TH', 'VN', 'PH', 'KH', 'LA', 'MM', 'BN'].includes(c)) return 'South-East Asia';
  if (['JP', 'KR', 'CN', 'HK', 'TW', 'MN'].includes(c)) return 'East Asia';
  if (['AE', 'SA', 'QA', 'KW', 'BH', 'OM', 'IL', 'JO', 'LB', 'TR', 'EG', 'MA', 'DZ', 'TN', 'LY'].includes(c)) return 'Middle East & North Africa';
  if (['GB', 'IE', 'FR', 'DE', 'NL', 'BE', 'LU', 'CH', 'AT', 'IT', 'ES', 'PT', 'SE', 'NO', 'DK', 'FI', 'IS', 'PL', 'CZ', 'SK', 'HU', 'RO', 'BG', 'GR', 'HR', 'SI', 'RS', 'BA', 'MD', 'UA', 'RU', 'LT', 'LV', 'EE', 'CY'].includes(c)) return 'Europe';
  if (['US', 'CA', 'MX'].includes(c)) return 'North America';
  if (['BR', 'AR', 'CL', 'CO', 'PE', 'EC', 'VE', 'UY', 'PY', 'BO', 'CR', 'PA', 'DO', 'GT'].includes(c)) return 'Latin America';
  if (['AU', 'NZ', 'FJ', 'PG'].includes(c)) return 'Oceania';
  if (['ZA', 'NG', 'KE', 'GH', 'TZ', 'UG', 'ET'].includes(c)) return 'Africa';
  return 'Other';
}