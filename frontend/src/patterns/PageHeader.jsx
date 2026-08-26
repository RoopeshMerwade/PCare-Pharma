import { cn } from '../lib/cn';

/* Page title block. The shell already renders the title in the topbar at lg+,
   so this shows it only below that breakpoint to avoid saying it twice — and
   still carries the subtitle and actions at every width.

   space.7 is permitted at page level (§2.3) but is not used here: the shell's
   own py-s5 already sets the page rhythm, and stacking both would push the
   first row of content below the fold on a counter tablet. */

export default function PageHeader({ title, subtitle, actions, className }) {
  return (
    <div className={cn('mb-s4 flex flex-wrap items-start justify-between gap-s3', className)}>
      <div className="min-w-0">
        {title && <h1 className="text-lg font-bold text-foreground lg:hidden">{title}</h1>}
        {subtitle && <p className="mt-s1 text-base text-muted-foreground">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-s2">{actions}</div>}
    </div>
  );
}
