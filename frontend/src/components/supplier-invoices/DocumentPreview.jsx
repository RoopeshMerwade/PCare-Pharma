import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import Button from '../../ui/Button';
import ErrorState from '../../ui/ErrorState';
import Skeleton, { SkeletonRegion } from '../../ui/Skeleton';

/* ═══════════════════════════════════════════════════════════════════════════
   DocumentPreview — the left half of the review screen.

   The reviewer's job is to compare two things, so both have to be on screen at
   once. This is the "one" of that pair: the actual document, at a size where a
   batch number is legible, next to the fields it is being checked against.

   The URL is signed and short-lived (the bucket is private), so it is fetched
   per mount rather than stored anywhere. When it expires the iframe simply
   stops loading, which is why "Open in a new tab" and a re-fetch are both
   offered rather than assuming the link lives as long as the review does.

   PDFs go in an <iframe>, images in an <img>. Not a PDF.js build: a viewer
   dependency to render a document the browser already renders would be weight
   for nothing, and the native viewer brings its own zoom and page controls —
   which is precisely what someone squinting at a smudged expiry needs.
   ═══════════════════════════════════════════════════════════════════════════ */

export default function DocumentPreview({ invoiceId, fileName }) {
  const [doc, setDoc] = useState(null);
  const [error, setError] = useState(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!invoiceId) return undefined;
    let cancelled = false;
    setDoc(null);
    setError(null);

    api.get(`/supplier-invoices/${invoiceId}/document`)
      .then((res) => { if (!cancelled) setDoc(res.data); })
      .catch((err) => { if (!cancelled) setError(err); });

    return () => { cancelled = true; };
  }, [invoiceId, nonce]);

  const isPdf = doc?.mime === 'application/pdf';
  const label = doc?.file_name || fileName || 'the supplier invoice';

  return (
    // Same card treatment (border, bg-card, p-s3) as the "Invoice details"
    // section it sits beside — two bare, differently-styled blocks side by
    // side read as unrelated content; matching panels read as a pair, and it
    // is what puts both columns' top edges at the same spot.
    <section
      aria-label="Original document"
      className="flex min-h-0 flex-col gap-s2 rounded-card border border-border bg-card p-s3"
    >
      <div className="flex flex-wrap items-center justify-between gap-s2">
        <h2 className="text-sm font-bold text-foreground">Original document</h2>
        <div className="flex items-center gap-s2">
          <Button variant="ghost" size="compact" onClick={() => setNonce((n) => n + 1)}>
            Reload
          </Button>
          {doc?.url && (
            // Opening the real file full-screen beats any zoom control this
            // panel could offer, and it is the fallback when a scan is dense.
            <Button variant="secondary" size="compact" asChild>
              <a href={doc.url} target="_blank" rel="noreferrer noopener">
                Open full size
              </a>
            </Button>
          )}
        </div>
      </div>

      {error && (
        <ErrorState
          title="Couldn't open the original"
          message={`${error.message} The link may have expired — reload to get a fresh one.`}
          onRetry={() => setNonce((n) => n + 1)}
        />
      )}

      {!doc && !error && (
        <SkeletonRegion label="Loading the original document…">
          <Skeleton className="h-72 w-full rounded-card lg:h-[540px]" />
        </SkeletonRegion>
      )}

      {doc?.url && !error && (
        <div className="overflow-hidden rounded-card border border-border bg-muted">
          {isPdf ? (
            <iframe
              key={doc.url}
              src={doc.url}
              title={`Invoice document: ${label}`}
              className="h-[520px] w-full border-0 bg-card lg:h-[calc(100vh-15rem)] lg:min-h-[500px]"
            />
          ) : (
            <div className="flex max-h-[520px] items-center justify-center overflow-auto overscroll-contain bg-muted/40 p-s1 lg:max-h-[calc(100vh-15rem)] lg:min-h-[500px]">
              <img
                key={doc.url}
                src={doc.url}
                alt={`Photographed supplier invoice: ${label}. Compare it against the fields on the right.`}
                className="block max-h-[500px] w-full max-w-full object-contain lg:max-h-[calc(100vh-17rem)]"
              />
            </div>
          )}
        </div>
      )}

      {doc && (
        <p className="text-base text-muted-foreground">
          {label}
          {doc.expires_in ? ` · link expires in ${Math.round(doc.expires_in / 60)} min` : ''}
        </p>
      )}
    </section>
  );
}
