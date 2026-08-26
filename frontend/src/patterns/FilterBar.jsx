import { useId } from 'react';
import { cn } from '../lib/cn';
import Input from '../ui/Input';
import Select from '../ui/Select';
import { SearchIcon } from '../ui/icons';

/* Search + dropdown filters for a list page.

   The search box carries a real <label>, visually hidden rather than absent:
   §3.5 forbids placeholder-only labelling, and "Search" is exactly the field
   where that shortcut is usually taken. */

export default function FilterBar({ search, onSearchChange, searchPlaceholder, searchLabel = 'Search', filters = [], className }) {
  const searchId = useId();

  return (
    <div className={cn('mb-s4 flex flex-wrap items-end gap-s2', className)}>
      {/* `relative` on the sr-only labels' wrappers: an absolute element with
          no positioned ancestor escapes every scroll container up to the
          <body> and inflates the page's scrollable area. */}
      {onSearchChange && (
        <div className="relative min-w-[14rem] flex-1">
          <label htmlFor={searchId} className="sr-only">{searchLabel}</label>
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute left-s3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id={searchId}
              type="search"
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder={searchPlaceholder}
              className="pl-s6"
            />
          </div>
        </div>
      )}

      {filters.map((filter) => (
        <div key={filter.key} className="relative min-w-[10rem]">
          <label htmlFor={`${searchId}-${filter.key}`} className="sr-only">{filter.label}</label>
          <Select
            id={`${searchId}-${filter.key}`}
            value={filter.value}
            onChange={(e) => filter.onChange(e.target.value)}
          >
            {filter.options.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </Select>
        </div>
      ))}
    </div>
  );
}
