import { Link } from 'react-router-dom';
import Shell from '@/components/shell';
import { Button } from '@/components/ui/button';

export default function HomePage() {
  return (
    <Shell>
      <section className="mx-auto flex w-full max-w-2xl flex-col items-center px-6 py-20 text-center sm:py-28">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
          Your important text
        </h1>
        <p className="mt-4 max-w-md text-lg text-muted-foreground">
          A supporting sentence goes here.
        </p>
        <Button asChild size="lg" className="mt-8">
          <Link to="/entries">Your call to action</Link>
        </Button>
      </section>
    </Shell>
  );
}
