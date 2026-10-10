/**
 * Apprentissage du décalage systématique.
 *
 * Chaque calage manuel est une mesure : l'utilisateur affirme « à cet instant,
 * cette ligne commence ». Quand plusieurs calages convergent, l'écart commun ne
 * vient pas des paroles mais de la chaîne de lecture (latence de sortie audio,
 * retard de la position rapportée). Cette part-là vaut pour *tous* les morceaux
 * et n'a aucune raison d'être ressaisie à chaque fois.
 *
 * Ce qui reste après elle — la part propre à une version, un clip, une reprise —
 * demeure attaché au morceau.
 */

/** On garde une fenêtre glissante : une vieille mesure n'a plus de valeur. */
const MAX_HISTORY = 20;

/** En dessous, la médiane ne veut rien dire. */
const MIN_SAMPLES = 3;

/**
 * Une latence de chaîne audio dépasse rarement la seconde. Au-delà, l'écart est
 * propre au morceau (mauvais LRC, autre version) et l'appliquer partout
 * dérèglerait tout le reste.
 */
const MAX_AUTO_GLOBAL_MS = 3000;

export interface CalibrationInput {
  /** Décalage total jugé correct par l'utilisateur pour le morceau courant. */
  total: number;
  /** Calages précédents, du plus ancien au plus récent. */
  history: number[];
  currentGlobal: number;
  trackOffsets: Record<string, number>;
  videoId: string;
  /** Apprentissage actif ? Sinon seul le morceau courant est ajusté. */
  enabled: boolean;
}

export interface CalibrationResult {
  history: number[];
  global: number;
  trackOffsets: Record<string, number>;
  /** Nombre de mesures ayant servi à la médiane, pour l'affichage. */
  samples: number;
}

/** Médiane : une seule frappe ratée ne doit pas déplacer l'estimation. */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const tri = [...values].sort((a, b) => a - b);
  const milieu = Math.floor(tri.length / 2);
  return tri.length % 2 ? tri[milieu]! : Math.round((tri[milieu - 1]! + tri[milieu]!) / 2);
}

const clamp = (v: number) => Math.max(-MAX_AUTO_GLOBAL_MS, Math.min(MAX_AUTO_GLOBAL_MS, v));

export function calibrate(input: CalibrationInput): CalibrationResult {
  const history = [...input.history, Math.round(input.total)].slice(-MAX_HISTORY);

  const global =
    input.enabled && history.length >= MIN_SAMPLES ? clamp(median(history)) : input.currentGlobal;

  // Déplacer le décalage global changerait tous les morceaux déjà calés. On les
  // rebase de l'écart exact pour que leur résultat effectif reste identique :
  // seuls les morceaux jamais calés profitent de la nouvelle valeur.
  const ecart = input.currentGlobal - global;
  const trackOffsets: Record<string, number> = {};
  for (const [id, valeur] of Object.entries(input.trackOffsets)) {
    trackOffsets[id] = valeur + ecart;
  }

  // Le morceau courant est fixé après rebase, donc exact par construction.
  const residuel = Math.round(input.total) - global;
  if (residuel === 0) delete trackOffsets[input.videoId];
  else trackOffsets[input.videoId] = residuel;

  return { history, global, trackOffsets, samples: history.length };
}
