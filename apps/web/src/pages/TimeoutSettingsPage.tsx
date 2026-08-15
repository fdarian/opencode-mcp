import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { orpc } from '@/lib/orpc';

export function TimeoutSettingsPage() {
	const queryClient = useQueryClient();
	const [minutes, setMinutes] = useState(30);

	const timeoutQuery = useQuery({
		queryKey: ['settings', 'startTimeout'],
		queryFn: () => orpc.settings.getStartTimeout(),
	});

	useEffect(() => {
		if (timeoutQuery.data !== undefined) {
			setMinutes(timeoutQuery.data.minutes);
		}
	}, [timeoutQuery.data]);

	const saveMutation = useMutation({
		mutationFn: (input: { minutes: number }) =>
			orpc.settings.setStartTimeout(input),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ['settings', 'startTimeout'] });
		},
	});

	const parsedMinutes = Number.parseInt(String(minutes), 10);
	const canSave =
		!Number.isNaN(parsedMinutes) &&
		parsedMinutes >= 1 &&
		!saveMutation.isPending &&
		!timeoutQuery.isLoading;

	function handleSave() {
		if (!canSave) return;
		saveMutation.mutate({ minutes: parsedMinutes });
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<header className="flex items-center justify-between border-b border-border px-22 py-15">
				<span className="text-subheading font-light text-foreground">
					Timeout
				</span>
			</header>

			<main className="flex-1 overflow-y-auto px-33 py-22">
				<div className="mx-auto max-w-[900px]">
					{timeoutQuery.isLoading ? (
						<p className="text-sm text-muted-foreground">Loading…</p>
					) : timeoutQuery.isError ? (
						<p className="text-sm text-destructive">
							Failed to load timeout setting
						</p>
					) : (
						<div className="grid max-w-md gap-4">
							<p className="text-sm text-muted-foreground">
								How long the MCP <code className="font-mono">start</code> tool
								blocks before returning a running handle when{' '}
								<code className="font-mono">background</code> is false.
							</p>
							<Field>
								<FieldLabel htmlFor="start-timeout-minutes">Minutes</FieldLabel>
								<Input
									id="start-timeout-minutes"
									type="number"
									min={1}
									step={1}
									value={minutes}
									onChange={(e) => setMinutes(Number(e.target.value))}
								/>
							</Field>
							<div>
								<Button type="button" disabled={!canSave} onClick={handleSave}>
									{saveMutation.isPending ? 'Saving…' : 'Save'}
								</Button>
							</div>
							{saveMutation.isError ? (
								<p className="text-sm text-destructive">
									{saveMutation.error.message}
								</p>
							) : null}
						</div>
					)}
				</div>
			</main>
		</div>
	);
}
