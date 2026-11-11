import { useEffect, useSyncExternalStore } from 'react';
import {
  getCurrentUser,
  isUserResolved,
  refreshUser,
  subscribeUser,
  type UserProfile,
} from '@/services/userApi';

/**
 * Subscribes to the account store.
 *
 * `status` distinguishes "still asking the server" from "definitely logged out",
 * which is what stops the header from flashing a 登录 button for a moment on
 * every page load for a signed-in user.
 */
export function useUser(): {
  user: UserProfile | null;
  status: 'loading' | 'anonymous' | 'authed';
} {
  // Probe once per mount of the first consumer; refreshUser() collapses
  // concurrent calls into one request.
  useEffect(() => {
    if (!isUserResolved()) void refreshUser();
  }, []);

  const snapshot = useSyncExternalStore(
    subscribeUser,
    () => `${isUserResolved() ? 'r' : 'p'}:${getCurrentUser()?.id ?? ''}`,
    () => 'p:',
  );

  const user = getCurrentUser();
  const status = !snapshot.startsWith('r') ? 'loading' : user ? 'authed' : 'anonymous';
  return { user, status };
}
