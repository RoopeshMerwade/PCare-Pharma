/* Shared shell for the four unauthenticated surfaces (sign in, forgot
   password, reset password, unauthorized). They sit outside AppShell, so they
   need their own page padding — this is the one place a page owns it.

   The canvas texture (.auth-canvas, in index.css) is a dot grid at
   blister-pack spacing, not a generic gradient blob — it's decorative and
   carries no information, so nothing here needs aria-hidden for it; it's a
   background-image, invisible to a screen reader already. */

export default function AuthLayout({ title, subtitle, children, footer }) {
  return (
    <div className="auth-canvas flex min-h-screen items-center justify-center bg-background px-s4 py-s6">
      <div className="w-full max-w-[26rem] animate-fade-in">
        <div className="mb-s5 flex flex-col items-center gap-s3 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-pill bg-primary text-primary-foreground shadow-1">
            {/* A filled cross — pharmacy signage, not the app's own PlusIcon
                (icons.jsx), which this would be pixel-identical to as an
                outline. The mark for "this is a pharmacy" and the icon for
                "add something" must not be the same glyph. */}
            <svg viewBox="0 0 24 24" className="h-7 w-7" aria-hidden="true">
              <path d="M9 3H15V9H21V15H15V21H9V15H3V9H9V3Z" fill="currentColor" />
            </svg>
          </span>
          <div>
            <h1 className="text-lg font-bold text-foreground">{title}</h1>
            {subtitle && <p className="mt-s1 text-base text-muted-foreground">{subtitle}</p>}
          </div>
        </div>

        <div className="rounded-card border border-border bg-card p-s5 shadow-2">{children}</div>

        {footer && <div className="mt-s4 text-center">{footer}</div>}
      </div>
    </div>
  );
}
