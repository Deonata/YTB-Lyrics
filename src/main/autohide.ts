/**
 * Décision d'escamotage, isolée du reste pour être vérifiable seule.
 *
 * Le point délicat est de ne jamais confondre « masquée par nous » et « masquée
 * par l'utilisateur » : seule la première situation autorise un retour
 * automatique, sinon la fenêtre réapparaîtrait alors qu'on l'a fermée exprès.
 */
export interface AutoHideState {
  /** La musique joue-t-elle ? Les publicités comptent comme de la lecture. */
  playing: boolean;
  /** Le réglage est-il activé ? */
  enabled: boolean;
  /** L'utilisateur veut-il la fenêtre visible ? */
  pipVisible: boolean;
  /** Déjà escamotée par nous. */
  autoHidden: boolean;
  /** Un escamotage est déjà programmé (fondu en cours ou minuterie armée). */
  pending: boolean;
}

export type AutoHideDecision = 'rien' | 'annuler' | 'programmer';

export function decideAutoHide(state: AutoHideState): AutoHideDecision {
  // Lecture en cours, ou fonction désactivée : on ramène la fenêtre s'il y a
  // quelque chose à défaire, sinon on ne touche à rien.
  if (state.playing || !state.enabled) {
    return state.autoHidden || state.pending ? 'annuler' : 'rien';
  }

  // En pause : ne pas reprogrammer par-dessus un escamotage déjà en cours.
  if (state.autoHidden || state.pending) return 'rien';

  // Masquée volontairement : ce n'est pas à nous de la manipuler.
  if (!state.pipVisible) return 'rien';

  return 'programmer';
}
