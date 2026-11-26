'use client';

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="mx-auto max-w-xl py-16 text-center">
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="mt-2 text-sm text-neutral-600">{error.message || 'The page could not be loaded.'}</p>
      <p className="mt-1 text-xs text-neutral-400">If it keeps happening, check that the database is running (System page). {error.digest && `Ref ${error.digest}`}</p>
      <button onClick={reset} className="mt-4 rounded-md border border-neutral-300 px-3 py-1.5 text-sm">Try again</button>
    </div>
  );
}
