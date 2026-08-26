import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useTheme } from '../../hooks/useTheme';
import Button from '../../ui/Button';
import { SunIcon, MoonIcon, CheckIcon } from '../../ui/icons';
import { cn } from '../../lib/cn';

/* ═══════════════════════════════════════════════════════════════════════════
   ThemeToggle — Radix DropdownMenu for Light / Dark / System themes.
   Trigger icon reflects the active resolved theme (Sun or Moon).
   ═══════════════════════════════════════════════════════════════════════════ */

const THEME_OPTIONS = [
  { value: 'light', label: 'Light', icon: SunIcon },
  { value: 'dark', label: 'Dark', icon: MoonIcon },
  { value: 'system', label: 'System' },
];

export default function ThemeToggle() {
  const { theme, resolvedTheme, setTheme } = useTheme();

  const TriggerIcon = resolvedTheme === 'dark' ? MoonIcon : SunIcon;
  const currentLabel = theme.charAt(0).toUpperCase() + theme.slice(1);

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Theme: ${currentLabel}`}
          className="text-foreground hover:bg-muted"
        >
          <TriggerIcon className="h-5 w-5" />
        </Button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className={cn(
            'z-50 min-w-[9rem] overflow-hidden rounded-control border border-border bg-card p-s1 shadow-2 animate-fade-in'
          )}
        >
          <DropdownMenu.RadioGroup value={theme} onValueChange={setTheme}>
            {THEME_OPTIONS.map((opt) => (
              <DropdownMenu.RadioItem
                key={opt.value}
                value={opt.value}
                className={cn(
                  'flex min-h-target cursor-pointer items-center justify-between gap-s2 rounded-control px-s3 py-s2 text-base outline-none',
                  'transition-colors duration-instant',
                  'hover:bg-muted focus-visible:bg-muted',
                  theme === opt.value ? 'font-bold text-foreground' : 'text-muted-foreground'
                )}
              >
                <span>{opt.label}</span>
                {theme === opt.value && <CheckIcon className="h-4 w-4 shrink-0 text-accent" />}
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
