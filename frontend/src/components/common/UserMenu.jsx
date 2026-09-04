import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { cn } from '../../lib/cn';
import { initials } from '../../lib/format';
import { ChevronIcon, LogoutIcon } from '../../ui/icons';

/* ═══════════════════════════════════════════════════════════════════════════
   UserMenu — identity and sign-out, in the header beside the bell.

   These two used to sit in the sidebar footer, which meant they were only
   reachable on desktop when the rail was expanded, and behind the drawer on
   mobile. The header is present at every breakpoint, so putting them here is
   what makes "who am I signed in as" and "sign out" answerable in one look
   and one click on any screen.

   Log out lives INSIDE the menu rather than beside the avatar on purpose: a
   bare one-click Log out next to the notification bell is a destructive
   action a thumb finds by accident at the counter. The menu is the
   confirmation step.
   ═══════════════════════════════════════════════════════════════════════════ */

export default function UserMenu({ user, onLogout }) {
  const name = user?.full_name || 'Account';

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          // The visible name is the label at lg+; below that the avatar is all
          // there is, so the accessible name has to carry it either way (A10).
          aria-label={`Account: ${name}${user?.role ? `, ${user.role}` : ''}`}
          className={cn(
            'flex min-h-target items-center gap-s2 rounded-pill px-s1 py-s1 text-left',
            'transition-colors duration-instant hover:bg-muted lg:pr-s2'
          )}
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-pill bg-primary text-base font-bold text-primary-foreground">
            {initials(user?.full_name)}
          </span>
          <span className="hidden min-w-0 lg:block">
            <span className="block max-w-[10rem] truncate text-base font-bold leading-tight text-foreground">
              {name}
            </span>
            <span className="block text-base capitalize leading-tight text-muted-foreground">
              {user?.role}
            </span>
          </span>
          {/* ChevronIcon points left; -90° turns it into the disclosure caret. */}
          <ChevronIcon className="hidden h-4 w-4 shrink-0 -rotate-90 text-muted-foreground lg:block" aria-hidden="true" />
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="z-50 min-w-[12rem] overflow-hidden rounded-control border border-border bg-card p-s1 shadow-2 animate-fade-in"
        >
          {/* Repeated inside the menu because the trigger hides it below lg —
              on a phone this is the only place the signed-in name appears. */}
          <DropdownMenu.Label className="px-s3 py-s2">
            <span className="block truncate text-base font-bold text-foreground">{name}</span>
            <span className="block text-base capitalize text-muted-foreground">{user?.role}</span>
          </DropdownMenu.Label>

          <DropdownMenu.Separator className="my-s1 h-px bg-border" />

          <DropdownMenu.Item
            onSelect={onLogout}
            className={cn(
              'flex min-h-target cursor-pointer items-center gap-s2 rounded-control px-s3 py-s2 text-base font-bold outline-none',
              'text-destructive-ink transition-colors duration-instant',
              'hover:bg-destructive-wash focus-visible:bg-destructive-wash data-[highlighted]:bg-destructive-wash'
            )}
          >
            <LogoutIcon className="h-[18px] w-[18px] shrink-0" />
            Log out
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
