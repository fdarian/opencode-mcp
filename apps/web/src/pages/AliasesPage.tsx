import { useForm } from '@tanstack/react-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronsUpDown } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from '@/components/ui/command';
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from '@/components/ui/popover';
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { orpc } from '@/lib/orpc';
import { cn } from '@/lib/utils';

type Backend = 'opencode' | 'cursor' | 'grok' | 'codex';

type Alias = {
	name: string;
	backend: Backend;
	model_id: string;
	description?: string;
};

type ModelComboboxProps = {
	backend: Backend;
	value: string;
	onChange: (modelId: string) => void;
	invalid: boolean;
};

function ModelCombobox(props: ModelComboboxProps) {
	const [open, setOpen] = useState(false);
	const modelsQuery = useQuery({
		queryKey: ['models', props.backend],
		queryFn: () => orpc.models.list({ backend: props.backend }),
		staleTime: 5 * 60 * 1000,
	});

	const models = modelsQuery.data ?? [];

	// Find the selected entry to render its label in the trigger button.
	const selectedEntry = models.find((entry) => entry.id === props.value);

	const triggerContent =
		props.value.trim() === '' ? (
			<span className="font-sans text-muted-foreground">Select model…</span>
		) : selectedEntry?.label !== undefined ? (
			<span className="flex items-baseline gap-2 overflow-hidden">
				<span className="shrink-0 font-medium">{selectedEntry.label}</span>
				<span className="truncate font-mono text-xs text-muted-foreground">
					{props.value}
				</span>
			</span>
		) : (
			<span className="truncate font-mono">{props.value}</span>
		);

	return (
		<Popover open={open} onOpenChange={setOpen} modal>
			<PopoverTrigger asChild>
				<Button
					type="button"
					variant="outline"
					role="combobox"
					aria-expanded={open}
					aria-invalid={props.invalid}
					className="w-full justify-between text-foreground"
				>
					{triggerContent}
					<ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
				</Button>
			</PopoverTrigger>
			<PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0">
				<Command>
					<CommandInput placeholder="Search models…" />
					<CommandList>
						{modelsQuery.isLoading ? (
							<div className="py-6 text-center text-sm text-muted-foreground">
								Loading models…
							</div>
						) : modelsQuery.isError ? (
							<div className="flex flex-col items-center gap-2 py-6 text-sm">
								<p className="text-destructive">
									Failed to load models for {props.backend}
								</p>
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={() => modelsQuery.refetch()}
								>
									Retry
								</Button>
							</div>
						) : (
							<>
								<CommandEmpty>No matching models.</CommandEmpty>
								<CommandGroup>
									{models.map((entry) => (
										<CommandItem
											key={entry.id}
											// Include both label and id so the user can type either to match.
											value={
												entry.label !== undefined
													? `${entry.label} ${entry.id}`
													: entry.id
											}
											onSelect={() => {
												props.onChange(entry.id);
												setOpen(false);
											}}
										>
											<Check
												className={cn(
													'mr-2 h-4 w-4 shrink-0',
													props.value === entry.id
														? 'opacity-100'
														: 'opacity-0',
												)}
											/>
											{entry.label !== undefined ? (
												<div className="flex min-w-0 flex-col leading-snug">
													<span className="font-medium">{entry.label}</span>
													<span className="truncate font-mono text-xs text-muted-foreground">
														{entry.id}
													</span>
												</div>
											) : (
												<span className="truncate font-mono leading-[1.6rem]">
													{entry.id}
												</span>
											)}
										</CommandItem>
									))}
								</CommandGroup>
							</>
						)}
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}

type AliasFormProps = {
	editingAlias: Alias | undefined;
	onSuccess: () => void;
	onCancel: () => void;
};

type AliasFormValues = {
	name: string;
	backend: Backend;
	model_id: string;
	description: string;
};

function AliasForm(props: AliasFormProps) {
	const queryClient = useQueryClient();
	// Server-side error to surface under the model_id field.
	const [serverModelError, setServerModelError] = useState<
		string | undefined
	>();

	const saveMutation = useMutation({
		mutationFn: (input: {
			name: string;
			backend: Backend;
			model_id: string;
			description?: string;
		}) => orpc.aliases.save(input),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ['aliases'] });
			props.onSuccess();
		},
		onError: (error: Error) => {
			setServerModelError(error.message);
		},
	});

	const defaultValues: AliasFormValues = {
			name: props.editingAlias?.name ?? '',
			backend: props.editingAlias?.backend ?? 'opencode',
			model_id: props.editingAlias?.model_id ?? '',
			description: props.editingAlias?.description ?? '',
	};
	const form = useForm({
		defaultValues,
		onSubmit: ({ value }) => {
			setServerModelError(undefined);
			saveMutation.mutate({
				name: value.name.trim(),
				backend: value.backend,
				model_id: value.model_id.trim(),
				description:
					value.description.trim() === ''
						? undefined
						: value.description.trim(),
			});
		},
	});

	return (
		<form
			onSubmit={(e) => {
				e.preventDefault();
				e.stopPropagation();
				form.handleSubmit();
			}}
			className="grid gap-4 py-4"
		>
			<form.Field
				name="name"
				validators={{
					onChange: ({ value }) => {
						if (value.trim() === '') return 'Name is required';
						if (!/^[a-z0-9-]+$/.test(value))
							return 'Name must be lowercase letters, numbers, or dashes only';
						return undefined;
					},
				}}
			>
				{(field) => {
					const isInvalid =
						field.state.meta.isTouched && field.state.meta.errors.length > 0;
					return (
						<Field data-invalid={isInvalid}>
							<FieldLabel htmlFor={field.name}>Name</FieldLabel>
							<Input
								id={field.name}
								value={field.state.value}
								disabled={props.editingAlias !== undefined}
								onBlur={field.handleBlur}
								onChange={(e) => field.handleChange(e.target.value)}
								placeholder="e.g. quick"
								aria-invalid={isInvalid}
							/>
							{isInvalid && (
								<FieldError
									errors={field.state.meta.errors.map((e) => ({
										message: typeof e === 'string' ? e : String(e),
									}))}
								/>
							)}
						</Field>
					);
				}}
			</form.Field>

			<form.Field name="backend">
				{(field) => (
					<Field>
						<FieldLabel htmlFor={field.name}>Backend</FieldLabel>
						<Select
							value={field.state.value}
							onValueChange={(value) => {
								field.handleChange(value as Backend);
								// Changing backend invalidates the model selection.
								form.setFieldValue('model_id', '');
								setServerModelError(undefined);
							}}
						>
							<SelectTrigger id={field.name}>
								<SelectValue placeholder="Select backend" />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="opencode">opencode</SelectItem>
								<SelectItem value="cursor">cursor</SelectItem>
								<SelectItem value="grok">grok</SelectItem>
								<SelectItem value="codex">codex</SelectItem>
							</SelectContent>
						</Select>
					</Field>
				)}
			</form.Field>

			<form.Field
				name="model_id"
				validators={{
					onChange: ({ value }) =>
						value.trim() === '' ? 'Pick a model from the dropdown' : undefined,
				}}
			>
				{(field) => {
					const isInvalid =
						(field.state.meta.isTouched &&
							field.state.meta.errors.length > 0) ||
						serverModelError !== undefined;
					const errors = [
						...field.state.meta.errors.map((e) => ({
							message: typeof e === 'string' ? e : String(e),
						})),
						...(serverModelError !== undefined
							? [{ message: serverModelError }]
							: []),
					];
					return (
						<Field data-invalid={isInvalid}>
							<FieldLabel htmlFor={field.name}>Model ID</FieldLabel>
							<form.Subscribe selector={(state) => state.values.backend}>
								{(backend: Backend) => (
									<ModelCombobox
										backend={backend}
										value={field.state.value}
										invalid={isInvalid}
										onChange={(modelId) => {
											field.handleChange(modelId);
											setServerModelError(undefined);
										}}
									/>
								)}
							</form.Subscribe>
							{isInvalid && <FieldError errors={errors} />}
						</Field>
					);
				}}
			</form.Field>

			<form.Field name="description">
				{(field) => (
					<Field>
						<FieldLabel htmlFor={field.name}>Description</FieldLabel>
						<Textarea
							id={field.name}
							value={field.state.value}
							onBlur={field.handleBlur}
							onChange={(e) => field.handleChange(e.target.value)}
							placeholder="Optional description"
						/>
					</Field>
				)}
			</form.Field>

			<DialogFooter>
				<Button type="button" variant="outline" onClick={props.onCancel}>
					Cancel
				</Button>
				<form.Subscribe
					selector={(state) => ({
						canSubmit: state.canSubmit,
						isSubmitting: state.isSubmitting,
					})}
				>
					{(state: { canSubmit: boolean; isSubmitting: boolean }) => (
						<Button
							type="submit"
							disabled={
								!state.canSubmit ||
								state.isSubmitting ||
								saveMutation.isPending ||
								form.getFieldValue('model_id').trim() === ''
							}
						>
							{saveMutation.isPending ? 'Saving…' : 'Save'}
						</Button>
					)}
				</form.Subscribe>
			</DialogFooter>
		</form>
	);
}

export function AliasesPage() {
	const queryClient = useQueryClient();
	const [isFormOpen, setIsFormOpen] = useState(false);
	const [editingAlias, setEditingAlias] = useState<Alias | undefined>();
	const [deleteTarget, setDeleteTarget] = useState<Alias | undefined>();
	const [deleteError, setDeleteError] = useState<string | undefined>();

	const listQuery = useQuery({
		queryKey: ['aliases'],
		queryFn: () => orpc.aliases.list(),
	});

	const deleteMutation = useMutation({
		mutationFn: (name: string) => orpc.aliases.delete({ name }),
		onSuccess: (result) => {
			if (result.ok) {
				queryClient.invalidateQueries({ queryKey: ['aliases'] });
				setDeleteTarget(undefined);
			} else {
				setDeleteError('Alias not found');
			}
		},
		onError: (error: Error) => {
			setDeleteError(error.message);
		},
	});

	function openCreate() {
		setEditingAlias(undefined);
		setIsFormOpen(true);
	}

	function openEdit(alias: Alias) {
		setEditingAlias(alias);
		setIsFormOpen(true);
	}

	function closeForm() {
		setIsFormOpen(false);
		setEditingAlias(undefined);
	}

	function handleDelete() {
		if (deleteTarget === undefined) return;
		deleteMutation.mutate(deleteTarget.name);
	}

	const aliases = (listQuery.data ?? []) as Alias[];

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<header className="flex items-center justify-between border-b border-border px-22 py-15">
				<span className="text-subheading font-light text-foreground">
					Aliases
				</span>
				<Button onClick={openCreate}>Create alias</Button>
			</header>

			<main className="flex-1 overflow-y-auto px-33 py-22">
				<div className="mx-auto max-w-[900px]">
					{listQuery.isLoading ? (
						<div className="py-66 text-center text-caption text-muted-foreground">
							Loading aliases…
						</div>
					) : aliases.length === 0 ? (
						<div className="flex flex-col items-center gap-22 py-66 text-muted-foreground">
							<p className="text-body font-light">No aliases yet</p>
							<p className="text-caption">
								Create your first alias to get started
							</p>
							<Button onClick={openCreate}>Create alias</Button>
						</div>
					) : (
						<table className="w-full text-left text-sm">
							<thead>
								<tr className="border-b border-border text-muted-foreground">
									<th className="py-3 pr-4 font-normal">Name</th>
									<th className="py-3 pr-4 font-normal">Backend</th>
									<th className="py-3 pr-4 font-normal">Model ID</th>
									<th className="py-3 pr-4 font-normal">Description</th>
									<th className="py-3 text-right font-normal">Actions</th>
								</tr>
							</thead>
							<tbody>
								{aliases.map((alias) => (
									<tr
										key={alias.name}
										className="border-b border-border last:border-b-0"
									>
										<td className="py-3 pr-4 font-mono text-foreground">
											{alias.name}
										</td>
										<td className="py-3 pr-4 text-foreground">
											{alias.backend}
										</td>
										<td className="py-3 pr-4 font-mono text-muted-foreground">
											{alias.model_id}
										</td>
										<td className="py-3 pr-4 text-muted-foreground">
											{alias.description}
										</td>
										<td className="py-3 text-right">
											<div className="flex items-center justify-end gap-2">
												<Button
													variant="ghost"
													size="sm"
													onClick={() => openEdit(alias)}
												>
													Edit
												</Button>
												<Button
													variant="ghost"
													size="sm"
													className="text-destructive hover:text-destructive"
													onClick={() => setDeleteTarget(alias)}
												>
													Delete
												</Button>
											</div>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					)}
				</div>
			</main>

			<Dialog
				open={isFormOpen}
				onOpenChange={(open) => {
					if (!open) closeForm();
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>
							{editingAlias === undefined ? 'Create alias' : 'Edit alias'}
						</DialogTitle>
						<DialogDescription>
							{editingAlias === undefined
								? 'Define a short name for a backend + model pair.'
								: 'Update the alias settings.'}
						</DialogDescription>
					</DialogHeader>
					{isFormOpen && (
						<AliasForm
							editingAlias={editingAlias}
							onSuccess={closeForm}
							onCancel={closeForm}
						/>
					)}
				</DialogContent>
			</Dialog>

			<Dialog
				open={deleteTarget !== undefined}
				onOpenChange={(open) => {
					if (!open) {
						setDeleteTarget(undefined);
						setDeleteError(undefined);
					}
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Delete alias?</DialogTitle>
						<DialogDescription>
							This will permanently delete the alias{' '}
							<code className="rounded bg-muted px-1 py-0.5 font-mono text-sm">
								{deleteTarget === undefined ? '' : deleteTarget.name}
							</code>
							. This action cannot be undone.
						</DialogDescription>
					</DialogHeader>
					{deleteError !== undefined && (
						<p className="text-sm text-destructive">{deleteError}</p>
					)}
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={() => {
								setDeleteTarget(undefined);
								setDeleteError(undefined);
							}}
						>
							Cancel
						</Button>
						<Button
							type="button"
							variant="destructive"
							disabled={deleteMutation.isPending}
							onClick={handleDelete}
						>
							{deleteMutation.isPending ? 'Deleting…' : 'Delete'}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
