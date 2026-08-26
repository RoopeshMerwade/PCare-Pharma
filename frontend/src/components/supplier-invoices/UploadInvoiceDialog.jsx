import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import FormDialog from '../../patterns/FormDialog';
import Field from '../../ui/Field';
import Select from '../../ui/Select';
import Spinner from '../../ui/Spinner';
import { controlClasses } from '../../ui/Input';
import { cn } from '../../lib/cn';

/* ═══════════════════════════════════════════════════════════════════════════
   UploadInvoiceDialog — the front door.

   The unusual thing about this form is how long its submit takes. Reading a
   multi-page invoice is a 5–60 second synchronous call, which is far outside
   what a spinner on a button communicates. So the dialog says what is
   happening, in stages, and says it in terms of the work rather than the
   technology: "Reading the invoice" is a thing the person understands is slow.

   FormDialog already prevents dismissal while submitting, which matters more
   here than anywhere else in the app — an Escape keypress forty seconds in
   would abandon a call that has already been paid for.

   Accepted types are enforced twice: the `accept` attribute so the OS picker
   filters, and the server's own mime allow-list, because `accept` is a hint a
   determined file manager will happily ignore.
   ═══════════════════════════════════════════════════════════════════════════ */

const ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp';
const MAX_MB = 12;

export default function UploadInvoiceDialog({ open, onOpenChange, suppliers, onUploaded }) {
  const [file, setFile] = useState(null);
  const [supplierId, setSupplierId] = useState('');
  const [error, setError] = useState(null);
  const [reading, setReading] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setFile(null);
    setSupplierId('');
    setError(null);
    setReading(false);
    if (inputRef.current) inputRef.current.value = '';
  }, [open]);

  const handleFile = (event) => {
    const picked = event.target.files?.[0] || null;
    setError(null);
    if (picked && picked.size > MAX_MB * 1024 * 1024) {
      // Caught here rather than after a 12MB round trip that ends in a 413.
      setError(`That file is ${(picked.size / (1024 * 1024)).toFixed(1)}MB. Re-scan it at a lower resolution, or split a long invoice into parts — ${MAX_MB}MB is the limit.`);
      setFile(null);
      return;
    }
    setFile(picked);
  };

  const handleSubmit = async () => {
    if (!file) throw new Error('Choose the invoice file first.');
    if (error) throw new Error(error);

    setReading(true);
    try {
      const res = await api.upload('/supplier-invoices', file, { supplier_id: supplierId });
      onUploaded(res.data.invoice);
    } finally {
      setReading(false);
    }
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Upload a supplier invoice"
      description="A PDF or a clear photo of the distributor's tax invoice. It is read once, then you check every line before anything reaches stock."
      submitLabel="Upload and read"
      onSubmit={handleSubmit}
      submitBlockedReason={!file ? 'Choose the invoice file first.' : error ? 'That file cannot be used — see the message above.' : null}
    >
      <Field
        label="Invoice file"
        required
        hint={`PDF, JPG, PNG or WebP · up to ${MAX_MB}MB`}
        error={error}
      >
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          onChange={handleFile}
          disabled={reading}
          className={cn(
            controlClasses,
            'flex cursor-pointer items-center py-s2',
            // The picker button is styled as a secondary control rather than
            // left as the browser default, which ignores every token in the
            // system and reads as a different app. `flex items-center` keeps
            // the pseudo-button vertically centred in the field — without it
            // the button's own padding makes it taller than the input's box
            // and it renders clipped against the top border.
            'file:mr-s3 file:cursor-pointer file:rounded-pill file:border file:border-solid file:border-border',
            'file:bg-card file:px-s3 file:py-s1 file:text-base file:font-bold file:text-foreground'
          )}
        />
      </Field>

      {file && (
        <p className="text-base text-muted-foreground">
          {file.name} · {(file.size / 1024).toFixed(0)} KB
        </p>
      )}

      <Field
        label="Distributor"
        hint="(optional — read from the invoice if left blank)"
      >
        <Select
          value={supplierId}
          disabled={reading}
          placeholder="Read it from the invoice"
          onChange={(e) => setSupplierId(e.target.value)}
        >
          {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Select>
      </Field>

      {reading && (
        // Not a progress bar: there is no progress to report from a single
        // synchronous call, and a bar that fakes one is worse than a sentence
        // that tells the truth about how long this takes.
        <p
          role="status"
          className="flex items-start gap-s2 rounded-control bg-muted px-s3 py-s2 text-base text-foreground"
        >
          <Spinner />
          <span>
            Reading the invoice — this takes up to a minute for a multi-page scan. Keep this
            window open; nothing is added to stock until you have checked the lines.
          </span>
        </p>
      )}
    </FormDialog>
  );
}
