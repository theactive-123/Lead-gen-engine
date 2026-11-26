import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="py-16 text-center">
      <h1 className="text-xl font-semibold">Not found</h1>
      <p className="mt-2 text-sm text-neutral-500">This lead, brand or page does not exist (it may have been deleted).</p>
      <Link href="/" className="mt-4 inline-block text-sm underline">Back to the overview</Link>
    </div>
  );
}
