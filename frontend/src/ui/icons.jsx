/* Inline icon set — no external icon dependency.
   Every icon inherits currentColor and is aria-hidden: an icon in this app
   always sits beside a text label (§3.6, A4), so announcing it again would be
   noise. Where an icon stands alone it is inside a button that carries its own
   aria-label. */

function icon(paths) {
  return function Icon({ className = 'h-[18px] w-[18px]', ...props }) {
    return (
      <svg
        className={className}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        {...props}
      >
        {paths}
      </svg>
    );
  };
}

export const HomeIcon    = icon(<><path d="M3 11.5 12 4l9 7.5" /><path d="M5 10v9a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1v-9" /></>);
export const BillIcon    = icon(<><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M9 7h6M9 11h6M9 15h3" /></>);
export const ListIcon    = icon(<><path d="M4 6h16M4 12h16M4 18h16" /></>);
export const BoxIcon     = icon(<><path d="M21 8 12 3 3 8l9 5 9-5Z" /><path d="M3 8v8l9 5 9-5V8" /><path d="M12 13v8" /></>);
export const PillIcon    = icon(<><rect x="3" y="9" width="18" height="6" rx="3" transform="rotate(-35 12 12)" /><path d="M9.5 9.5 14.5 14.5" /></>);
export const UsersIcon   = icon(<><circle cx="9" cy="8" r="3.2" /><path d="M3 20c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5" /><path d="M16 9a2.7 2.7 0 1 0 0-5.4" /><path d="M21 20c0-2.6-1.8-4.6-4-5.2" /></>);
export const ReturnIcon  = icon(<><path d="M4 12a8 8 0 1 1 3 6.3" /><path d="M4 18v-5h5" /></>);
export const TruckIcon   = icon(<><rect x="2" y="7" width="13" height="10" rx="1.5" /><path d="M15 10h4l3 3v4h-7z" /><circle cx="6.5" cy="19" r="1.8" /><circle cx="17.5" cy="19" r="1.8" /></>);
export const CartIcon    = icon(<><circle cx="9" cy="20" r="1.4" /><circle cx="18" cy="20" r="1.4" /><path d="M3 4h2l2.4 12h11.2L21 8H6" /></>);
export const ClockIcon   = icon(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.5 2" /></>);
export const ChartIcon   = icon(<><path d="M4 20V10M12 20V4M20 20v-7" /></>);
export const TagIcon     = icon(<><path d="M12 2 2 12l8 8 10-10V2z" /><circle cx="7" cy="7" r="1.3" fill="currentColor" /></>);
export const BellIcon    = icon(<><path d="M6 9a6 6 0 1 1 12 0c0 4.2 1.5 6 1.5 6H4.5S6 13.2 6 9Z" /><path d="M10 19a2 2 0 0 0 4 0" /></>);
export const GearIcon    = icon(<><circle cx="12" cy="12" r="3" /><path d="M19.4 13a7.7 7.7 0 0 0 0-2l2-1.4-2-3.4-2.3.7a7.6 7.6 0 0 0-1.7-1L15 3h-6l-.4 2.9a7.6 7.6 0 0 0-1.7 1l-2.3-.7-2 3.4L4.6 11a7.7 7.7 0 0 0 0 2l-2 1.4 2 3.4 2.3-.7a7.6 7.6 0 0 0 1.7 1L9 21h6l.4-2.9a7.6 7.6 0 0 0 1.7-1l2.3.7 2-3.4L19.4 13Z" /></>);
export const ShieldIcon  = icon(<><path d="M12 2 4 5v6c0 5 3.4 8.7 8 11 4.6-2.3 8-6 8-11V5l-8-3Z" /><path d="M9 12l2 2 4-4" /></>);
export const LogoutIcon  = icon(<><path d="M9 21H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h4" /><path d="M16 17l5-5-5-5" /><path d="M21 12H9" /></>);
export const ChevronIcon = icon(<><path d="M15 5l-7 7 7 7" /></>);
export const MenuIcon    = icon(<><path d="M4 6h16M4 12h16M4 18h16" /></>);
export const CloseIcon   = icon(<><path d="M6 6l12 12M18 6L6 18" /></>);
export const SearchIcon  = icon(<><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>);
export const PlusIcon    = icon(<><path d="M12 5v14M5 12h14" /></>);
export const AlertIcon   = icon(<><path d="M12 9v4M12 17h.01" /><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /></>);
export const CheckIcon   = icon(<><path d="M20 6 9 17l-5-5" /></>);
export const SunIcon     = icon(<><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" /></>);
export const MoonIcon    = icon(<><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" /></>);
/* A document being read, for Module 23. Distinct from BillIcon (a bill the
   pharmacy issues) by the corner fold and the scan line — the two sit in the
   same rail and an icon that reads as "a document" for both is no icon at all. */
export const ScanDocIcon = icon(<><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" /><path d="M14 3v5h5" /><path d="M8.5 13.5h7" /><path d="M8.5 17h4" /></>);
/* A clipboard with a written line, for Module 30. Distinct from BillIcon (a
   document the pharmacy ISSUES) and ListIcon (a generic list) by the clip: a
   requisition is a note handed to somebody, which is what a clipboard reads as.
   All three sit in the same rail. */
export const ClipboardIcon = icon(<><path d="M9 4h6a1 1 0 0 1 1 1v1H8V5a1 1 0 0 1 1-1Z" /><path d="M8 6H6.5A1.5 1.5 0 0 0 5 7.5v12A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5v-12A1.5 1.5 0 0 0 17.5 6H16" /><path d="M9 12h6M9 16h4" /></>);
export const DownloadIcon  = icon(<><path d="M12 3v12" /><path d="m7.5 10.5 4.5 4.5 4.5-4.5" /><path d="M4 20h16" /></>);

