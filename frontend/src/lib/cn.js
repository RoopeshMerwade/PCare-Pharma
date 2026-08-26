import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merge Tailwind classes so a caller's override actually wins.
 *
 * Without twMerge, `cn('px-s4', 'px-s2')` emits both and the cascade decides by
 * stylesheet order rather than by intent — which is how a variant's padding
 * silently beats the padding a caller passed in. Every component in ui/ funnels
 * its className through here for that reason.
 */
export function cn(...inputs) {
  return twMerge(clsx(inputs));
}
