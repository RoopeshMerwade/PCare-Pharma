/* Barrel for the design system. Pages import from here — `import { Button,
   Card, Table } from '../../ui'` — so a component can be re-homed without
   touching twenty call sites.

   Everything in ui/ is presentational and knows nothing about pharmacies.
   Anything that needs to know what a batch or a bill is belongs in domain/. */

export { default as Button, buttonVariants } from './Button';
export { default as Link } from './Link';
export { default as Spinner } from './Spinner';
export { default as Badge, badgeVariants } from './Badge';
export {
  default as Skeleton, SkeletonRegion, SkeletonText, SkeletonRows, SkeletonTable,
  SkeletonTile, SkeletonCard, SkeletonChart, SkeletonFields, SkeletonDetail,
} from './Skeleton';
export { default as EmptyState } from './EmptyState';
export { default as ErrorState } from './ErrorState';
export { default as Pagination, pageWindow } from './Pagination';

export { default as Card, CardHeader, CardTitle, CardDescription, CardBody, CardFooter } from './Card';
export { default as List, ListRow, ListField } from './List';
export { default as Table, visibleColumns } from './Table';

export { default as Field, useFieldControl } from './Field';
export { default as Input, NumericInput, Textarea, controlClasses } from './Input';
export { default as Select } from './Select';

export {
  Dialog, DialogTrigger, DialogClose, DialogContent,
  DialogHeader, DialogBody, DialogFooter,
  DialogTitle, DialogDescription,
} from './Dialog';
export {
  Drawer, DrawerTrigger, DrawerClose, DrawerContent,
  DrawerHeader, DrawerBody, DrawerFooter,
} from './Drawer';

export { ToastProvider, useToast } from './Toast';
export { Tabs, TabsList, TabsTrigger, TabsContent } from './Tabs';
export { default as Tooltip, TooltipProvider } from './Tooltip';
