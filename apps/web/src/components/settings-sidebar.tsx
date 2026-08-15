import { Link } from '@tanstack/react-router';
import { cn } from '@/lib/utils';

const NAV = [
	{ label: 'Aliases', to: '/settings/aliases' as const },
	{ label: 'Timeout', to: '/settings/timeout' as const },
];

export function SettingsSidebar() {
	return (
		<nav className="flex flex-col border-t border-border">
			{NAV.map((item) => (
				<Link
					key={item.to}
					to={item.to}
					activeProps={{
						className:
							'border-l-ink bg-[color-mix(in_srgb,var(--color-ink)_3%,var(--color-canvas))] text-foreground dark:bg-[color-mix(in_srgb,var(--color-ink)_8%,var(--color-canvas))]',
					}}
					inactiveProps={{
						className:
							'border-l-transparent text-muted-foreground hover:bg-[color-mix(in_srgb,var(--color-ink)_1%,var(--color-canvas))] hover:text-foreground dark:hover:bg-[color-mix(in_srgb,var(--color-ink)_5%,var(--color-canvas))]',
					}}
					className={cn('border-l px-22 py-15 text-caption transition-colors')}
				>
					{item.label}
				</Link>
			))}
		</nav>
	);
}
