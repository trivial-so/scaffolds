import { useState } from 'react';
import type { FormEvent } from 'react';
import Shell from '@/components/shell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useUser } from '@/lib/trivial-auth';
import { useTable } from '@/lib/trivial-data';

export default function EntriesPage() {
  const { user, signIn } = useUser();

  if (!user) {
    return (
      <Shell>
        <section className="mx-auto flex w-full max-w-md flex-col items-center px-6 py-20 text-center sm:py-28">
          <h1 className="text-2xl font-semibold tracking-tight">Entries</h1>
          <p className="mt-3 text-muted-foreground">
            Sign in to save entries. Each account sees only its own.
          </p>
          <Button className="mt-6" onClick={() => void signIn()}>
            Sign in
          </Button>
        </section>
      </Shell>
    );
  }

  return <SignedInEntries />;
}

// Mounted only once signed in, so the table read never runs as anonymous
// (an anonymous owner-table read is empty by design and would trip the
// workshop's signed-out remedy while this page already shows its own prompt).
function SignedInEntries() {
  // RLS scopes rows to the signed-in user server-side; never filter by user here.
  const { rows, loading, error, insert } = useTable('entries');
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaveError(null);
    try {
      await insert({ content: content.trim() });
      setContent('');
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Shell>
      <section className="mx-auto w-full max-w-xl px-6 py-16">
        <h1 className="text-2xl font-semibold tracking-tight">Entries</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Whatever you save lands in this app's database, scoped to your account.
        </p>
        <form onSubmit={save} className="mt-8 flex gap-2">
          <Input
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Write anything"
            required
          />
          <Button type="submit" disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </form>
        {(saveError || error) && (
          <p className="mt-4 text-sm text-destructive">{saveError ?? error?.message}</p>
        )}

        <h2 className="mt-12 text-sm font-medium text-muted-foreground">Your entries</h2>
        {loading ? (
          <div className="mt-3 flex flex-col gap-2">
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-5 w-1/2" />
          </div>
        ) : rows.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">Nothing saved yet.</p>
        ) : (
          <ul className="mt-3 divide-y divide-border border-y border-border">
            {rows.map((r) => (
              <li key={r.id} className="flex items-baseline justify-between gap-4 py-3">
                <p>{r.content}</p>
                <time className="shrink-0 text-xs text-muted-foreground">
                  {new Date(r.created_at).toLocaleDateString()}
                </time>
              </li>
            ))}
          </ul>
        )}
      </section>
    </Shell>
  );
}
