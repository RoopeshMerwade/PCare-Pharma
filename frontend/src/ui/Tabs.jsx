import * as RadixTabs from '@radix-ui/react-tabs';
import { cn } from '../lib/cn';

/* Tabs — Radix supplies roving tabindex and arrow-key navigation, which is the
   part of the WAI-ARIA tabs pattern that hand-rolled versions consistently
   omit. The active tab is marked by weight and an underline as well as colour,
   so it survives the A4 grayscale test. */

export const Tabs = RadixTabs.Root;

export function TabsList({ className, children, ...props }) {
  return (
    <RadixTabs.List
      className={cn('flex gap-s1 overflow-x-auto border-b border-border', className)}
      {...props}
    >
      {children}
    </RadixTabs.List>
  );
}

export function TabsTrigger({ className, children, ...props }) {
  return (
    <RadixTabs.Trigger
      className={cn(
        'min-h-target whitespace-nowrap border-b-2 border-transparent px-s3 py-s2 text-base font-bold',
        'text-muted-foreground transition-colors duration-instant',
        'hover:text-foreground',
        'data-[state=active]:border-accent data-[state=active]:text-accent',
        className
      )}
      {...props}
    >
      {children}
    </RadixTabs.Trigger>
  );
}

export function TabsContent({ className, children, ...props }) {
  return (
    <RadixTabs.Content className={cn('pt-s4', className)} {...props}>
      {children}
    </RadixTabs.Content>
  );
}
