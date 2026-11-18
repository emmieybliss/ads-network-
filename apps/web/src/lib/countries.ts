/** ISO 3166-1 alpha-2 codes (plus XK, Kosovo, which GeoIP databases use). */
export const COUNTRY_CODES = 'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW'.split(' ');

const NAMES = typeof Intl !== 'undefined' && 'DisplayNames' in Intl ? new Intl.DisplayNames(['en'], { type: 'region' }) : null;
export function countryLabel(code: string): string {
  if (code === 'ZZ') return 'Unknown';
  try { return NAMES?.of(code) ?? code; } catch { return code; }
}

/** Every country with its English name, sorted by name. */
export const COUNTRIES: Array<{ code: string; name: string }> = COUNTRY_CODES.map((code) => ({ code, name: countryLabel(code) })).sort((a, b) => a.name.localeCompare(b.name));

/** Quick picks for the country picker, like the location presets in ad platforms. */
export const COUNTRY_GROUPS: Array<{ id: string; label: string; codes: string[] }> = [
  { id: 'eu', label: 'European Union', codes: 'AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE'.split(' ') },
  { id: 'eea_uk', label: 'EEA, UK and Switzerland', codes: 'AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE IS LI NO GB CH'.split(' ') },
  { id: 'na', label: 'North America', codes: 'US CA MX'.split(' ') },
  { id: 'english', label: 'Main English-speaking', codes: 'US GB CA AU NZ IE'.split(' ') },
  { id: 'latam', label: 'Latin America', codes: 'AR BO BR CL CO CR CU DO EC SV GT HN MX NI PA PY PE PR UY VE'.split(' ') },
  { id: 'apac', label: 'Asia Pacific', codes: 'AU BD CN HK ID IN JP KR MY NZ PH PK SG LK TH TW VN'.split(' ') },
  { id: 'mena', label: 'Middle East and North Africa', codes: 'AE BH DZ EG IL IQ JO KW LB LY MA OM PS QA SA TN TR YE'.split(' ') },
  { id: 'ssa', label: 'Sub-Saharan Africa', codes: 'AO BJ BW CD CI CM ET GH KE MG MW MZ NA NG RW SN TZ UG ZA ZM ZW'.split(' ') },
];
