import type { ReactNode } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { useUser } from '@/lib/trivial-auth';

export default function Shell({ children }: { children: ReactNode }) {
  const { user, signIn, signOut } = useUser();

  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      <header className="border-b border-border">
        <div className="flex h-14 w-full items-center justify-between px-4 sm:px-6">
          <Link to="/" className="font-semibold tracking-tight">
            Placeholder
          </Link>
          <nav className="flex items-center gap-2 sm:gap-4">
            <NavLink
              to="/entries"
              className={({ isActive }) =>
                `text-sm ${isActive ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}`
              }
            >
              Entries
            </NavLink>
            {user ? (
              <div className="flex items-center gap-2">
                <span className="max-w-32 truncate text-sm text-muted-foreground">
                  {user.name ?? user.email ?? 'Signed in'}
                </span>
                <Button variant="ghost" size="sm" onClick={signOut}>
                  Sign out
                </Button>
              </div>
            ) : (
              <Button variant="outline" size="sm" onClick={() => void signIn()}>
                Sign in
              </Button>
            )}
          </nav>
        </div>
      </header>
      <main className="flex-1">{children}</main>
      <footer className="border-t border-border">
        <p className="w-full px-4 py-8 text-sm text-muted-foreground sm:px-6">
          Your footer text
        </p>
      </footer>
    </div>
  );
}
