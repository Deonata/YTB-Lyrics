import type { PipSettings } from './types';

/**
 * Un thème remplit les réglages d'apparence d'un coup ; ils restent ensuite
 * modifiables un par un. Rien ici n'est animé : cadres, dégradés et halos sont
 * peints une seule fois par le compositeur et n'entrent jamais dans la boucle
 * de rendu, qui ne touche qu'à la progression d'un mot par frame.
 */
/**
 * Volontairement sans `textAlign` ni `fontSize` : ce sont des préférences de
 * mise en place, propres à l'écran et à la taille de fenêtre de chacun. Un thème
 * qui les écrasait donnait l'impression de « tout remettre à zéro » à chaque essai.
 */
export type ThemeSettings = Pick<
  PipSettings,
  | 'backgroundColor'
  | 'textColor'
  | 'accentColor'
  | 'fontFamily'
  | 'fontWeight'
  | 'frameStyle'
  | 'textGlow'
  | 'dimOpacity'
  | 'cornerRadius'
  | 'opacity'
>;

export interface PipTheme {
  id: string;
  name: string;
  settings: ThemeSettings;
}

const SANS = '"Segoe UI Variable Display", "Segoe UI", Inter, system-ui, sans-serif';
const SERIF = 'Georgia, "Times New Roman", serif';
const MONO = '"Cascadia Mono", Consolas, monospace';

export const THEMES: PipTheme[] = [
  {
    id: 'minimal',
    name: 'Minimal',
    settings: {
      backgroundColor: '#0c0c10',
      textColor: '#ffffff',
      accentColor: '#ff2e5b',
      fontFamily: SANS,
      fontWeight: 600,
      frameStyle: 'fin',
      textGlow: false,
      dimOpacity: 0.32,
      cornerRadius: 14,
      opacity: 0.92,
    },
  },
  {
    id: 'neon',
    name: 'Néon',
    settings: {
      backgroundColor: '#05010f',
      textColor: '#e6e2ff',
      accentColor: '#00e5ff',
      fontFamily: SANS,
      fontWeight: 700,
      frameStyle: 'lueur',
      textGlow: true,
      dimOpacity: 0.22,
      cornerRadius: 12,
      opacity: 0.95,
    },
  },
  {
    id: 'sakura',
    name: 'Sakura',
    settings: {
      // Nuit plutôt que rose pâle : par-dessus d'autres fenêtres, un fond clair
      // délavé passait mal et le contraste du texte était trop faible.
      backgroundColor: '#1a0f18',
      textColor: '#fce7f0',
      accentColor: '#ff8fb8',
      fontFamily: SERIF,
      fontWeight: 600,
      frameStyle: 'petales',
      textGlow: false,
      dimOpacity: 0.26,
      cornerRadius: 20,
      opacity: 0.94,
    },
  },
  {
    id: 'cyberpunk',
    name: 'Cyberpunk',
    settings: {
      backgroundColor: '#0d0221',
      textColor: '#f2e9ff',
      accentColor: '#ff2a6d',
      fontFamily: SANS,
      fontWeight: 700,
      frameStyle: 'coins',
      textGlow: true,
      dimOpacity: 0.25,
      cornerRadius: 4,
      opacity: 0.94,
    },
  },
  {
    id: 'retro',
    name: 'Rétro CRT',
    settings: {
      backgroundColor: '#071008',
      textColor: '#9dff9d',
      accentColor: '#ffd94a',
      fontFamily: MONO,
      fontWeight: 500,
      frameStyle: 'scanlines',
      textGlow: true,
      dimOpacity: 0.28,
      cornerRadius: 8,
      opacity: 0.96,
    },
  },
  {
    id: 'minuit',
    name: 'Minuit',
    settings: {
      backgroundColor: '#0b1220',
      textColor: '#dbeafe',
      accentColor: '#60a5fa',
      fontFamily: SANS,
      fontWeight: 600,
      frameStyle: 'fin',
      textGlow: false,
      dimOpacity: 0.3,
      cornerRadius: 16,
      opacity: 0.9,
    },
  },
  {
    id: 'vinyle',
    name: 'Vinyle',
    settings: {
      backgroundColor: '#1b1512',
      textColor: '#f3e3cd',
      accentColor: '#d99a4e',
      fontFamily: SERIF,
      fontWeight: 600,
      frameStyle: 'double',
      textGlow: false,
      dimOpacity: 0.3,
      cornerRadius: 10,
      opacity: 0.94,
    },
  },
  {
    id: 'papier',
    name: 'Papier',
    settings: {
      backgroundColor: '#faf6ee',
      textColor: '#2c2823',
      accentColor: '#c2410c',
      fontFamily: SERIF,
      fontWeight: 600,
      frameStyle: 'ruban',
      textGlow: false,
      dimOpacity: 0.35,
      cornerRadius: 6,
      opacity: 0.97,
    },
  },
];

export interface FrameOption {
  id: PipSettings['frameStyle'];
  name: string;
  animated: boolean;
  /** Indication de coût affichée dans les réglages. */
  cost: string;
}

export const FRAME_STYLES: FrameOption[] = [
  // Statiques : peints une fois, coût nul ensuite.
  { id: 'aucun', name: 'Aucun', animated: false, cost: 'nul' },
  { id: 'fin', name: 'Liseré fin', animated: false, cost: 'nul' },
  { id: 'lueur', name: 'Lueur néon', animated: false, cost: 'nul' },
  { id: 'double', name: 'Double filet', animated: false, cost: 'nul' },
  { id: 'coins', name: 'Équerres', animated: false, cost: 'nul' },
  { id: 'ruban', name: 'Ruban', animated: false, cost: 'nul' },
  { id: 'scanlines', name: 'Scanlines', animated: false, cost: 'nul' },

  // Animés : tournent en continu tant que la fenêtre est visible.
  { id: 'lueur-pulse', name: 'Lueur pulsée', animated: true, cost: 'très léger' },
  { id: 'scanlines-anim', name: 'Scanlines défilantes', animated: true, cost: 'très léger' },
  { id: 'petales', name: 'Pétales', animated: true, cost: 'léger' },
  { id: 'balayage', name: 'Balayage rotatif', animated: true, cost: 'modéré' },
];
