import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Crown,
  MoreHorizontal,
  Plus,
  Search,
  Trash2,
} from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';

import { QueryError } from '~/components/QueryError';
import {
  Badge,
  Button,
  Checkbox,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsList,
  TabsTrigger,
} from '~/components/ui';
import { getPostStatusBadge, postHref, type Post } from '~/data/posts-registry';
import {
  deleteAnnouncement,
  deleteDraft,
  duplicateAnnouncement,
  duplicateAnnouncementDraft,
  loadPostsList,
} from '~/features/posts/api/announcements';
import {
  deleteConsentForm,
  deleteConsentFormDraft,
  duplicateConsentForm,
  duplicateConsentFormDraft,
  loadConsentPostsList,
} from '~/features/posts/api/consent-forms';
import { NotFoundError } from '~/features/posts/api/errors';
import { getConfigs } from '~/features/posts/api/session';
import type { ApiConfig } from '~/features/posts/api/types';
import {
  DeletePostDialog,
  type DeletePostDialogItem,
} from '~/features/posts/components/DeletePostDialog';
import {
  DEFAULT_POST_FILTERS,
  PostFilterPopover,
  type PostFilters,
  type PostOwnershipFilter,
  type PostResponseFilter,
  type PostStatusFilter,
} from '~/features/posts/components/PostFilterPopover';
import { ReadRateBar } from '~/features/posts/components/ReadRateBar';
import {
  SortableHeader,
  type SortDirection,
  type SortState,
} from '~/features/posts/components/SortableHeader';
import { usePagination } from '~/features/posts/hooks/usePagination';
import { formatDate } from '~/helpers/dateTime';
import { useQuery } from '~/hooks/useQuery';
import { notify } from '~/lib/notify';
import { cn, stripSalutation } from '~/lib/utils';

// ─── Local helpers ───────────────────────────────────────────────────────────

function getRelevantDate(post: Post): string | undefined {
  switch (post.kind) {
    case 'announcement':
      if (post.status === 'posted') return post.postedAt;
      if (post.status === 'scheduled') return post.scheduledAt;
      return post.createdAt;
    case 'form':
      if (post.status === 'open' || post.status === 'closed') return post.postedAt;
      if (post.status === 'scheduled') return post.scheduledAt;
      return post.createdAt;
    default:
      return undefined;
  }
}

function isLowReadRate(postedAt: string | undefined, readCount: number, total: number): boolean {
  if (!postedAt || total === 0) return false;
  const hoursElapsed = (Date.now() - new Date(postedAt).getTime()) / 3_600_000;
  return hoursElapsed >= 48 && readCount / total < 0.5;
}

function duplicateDraftHref(kind: 'announcement' | 'form', draftId: number): string {
  return kind === 'announcement'
    ? `announcements/drafts/${draftId}/edit`
    : `consent-forms/drafts/${draftId}/edit`;
}

export const __duplicateDraftHref = duplicateDraftHref;

type PostTab = 'view-only' | 'with-responses';

type PostRowData = Post & { _date: string | undefined; _dateTs: number };

// ─── Helpers ────────────────────────────────────────────────────────────────

const withDateTs = (p: Post): PostRowData => {
  const date = getRelevantDate(p);
  return { ...p, _date: date, _dateTs: date ? new Date(date).getTime() : 0 };
};

function comparePosts(a: PostRowData, b: PostRowData): number {
  if (a._dateTs !== b._dateTs) return b._dateTs - a._dateTs;
  if (a.kind !== b.kind) return a.kind === 'announcement' ? -1 : 1;
  return a.id.localeCompare(b.id);
}

function statusBucket(row: Pick<Post, 'status'>): PostStatusFilter | null {
  const s = row.status;
  if (s === 'posted' || s === 'posting' || s === 'open' || s === 'closed') return 'posted';
  if (s === 'scheduled') return 'scheduled';
  if (s === 'draft') return 'draft';
  return null;
}

export interface PostFilterQuery extends PostFilters {
  tab: PostTab;
  query: string;
}

export function matchesPostFilters(row: PostRowData, filters: PostFilterQuery): boolean {
  if (filters.tab === 'view-only' && row.kind === 'form') return false;
  if (filters.tab === 'with-responses' && row.kind !== 'form') return false;
  if (filters.query && !row.title.toLowerCase().includes(filters.query.toLowerCase())) return false;

  if (
    filters.ownership.length > 0 &&
    !filters.ownership.includes(row.ownership as PostOwnershipFilter)
  ) {
    return false;
  }

  if (filters.status.length > 0) {
    const bucket = statusBucket(row);
    if (bucket == null || !filters.status.includes(bucket)) return false;
  }

  if (
    filters.response.length > 0 &&
    !filters.response.includes(row.responseType as PostResponseFilter)
  ) {
    return false;
  }

  if (filters.dateFrom || filters.dateTo) {
    if (row._dateTs === 0) return false;
    if (filters.dateFrom && row._dateTs < Date.parse(`${filters.dateFrom}T00:00:00`)) return false;
    if (filters.dateTo && row._dateTs > Date.parse(`${filters.dateTo}T23:59:59.999`)) return false;
  }

  return true;
}

function dateLabel(status: Post['status']): string {
  if (status === 'scheduled') return 'Scheduled for';
  if (status === 'draft') return 'Edited on';
  return 'Posted on';
}

function createdByLabel(row: PostRowData): string {
  return row.ownership === 'shared' ? stripSalutation(row.createdBy) : 'Me';
}

function classLabelsFor(row: PostRowData): string | null {
  const labels =
    row.toParentsOf && row.toParentsOf.length > 0
      ? [...new Set(row.toParentsOf)]
      : [...new Set(row.recipients.map((r) => r.classLabel))];
  return labels.length > 0 ? labels.join(', ') : null;
}

/** Read (announcements) or responded (forms) counts, or null when not yet sent. */
function responseCounts(row: PostRowData): { count: number; total: number } | null {
  if (row.kind === 'announcement') {
    if (row.status !== 'posted') return null;
    return { count: row.stats.readCount, total: row.stats.totalCount };
  }
  if (row.status !== 'open' && row.status !== 'closed') return null;
  return { count: row.stats.totalCount - row.stats.pendingCount, total: row.stats.totalCount };
}

function compareBySort(a: PostRowData, b: PostRowData, sort: SortState): number {
  const dir = sort.direction === 'asc' ? 1 : -1;
  switch (sort.column) {
    case 'title':
      return a.title.localeCompare(b.title) * dir;
    case 'date':
      return (a._dateTs - b._dateTs) * dir;
    case 'status':
      return a.status.localeCompare(b.status) * dir;
    case 'created-by':
      return createdByLabel(a).localeCompare(createdByLabel(b)) * dir;
    default:
      return 0;
  }
}

function isDraftStatus(row: Pick<PostRowData, 'status'>): boolean {
  return row.status === 'draft' || row.status === 'scheduled';
}

function deletePostRow(row: PostRowData): Promise<unknown> {
  const isDraft = isDraftStatus(row);
  if (row.kind === 'form') {
    return isDraft ? deleteConsentFormDraft(row.numericId) : deleteConsentForm(row.numericId);
  }
  return isDraft ? deleteDraft(row.numericId) : deleteAnnouncement(row.numericId);
}

function toDeleteDialogItem(row: PostRowData): DeletePostDialogItem {
  return { title: row.title, isPosted: !isDraftStatus(row) };
}

const PAGE_SIZE = 20;

// Prototype: hardcoded as admin. In production this comes from the session.
const IS_ADMIN = true;

// ─── Component ──────────────────────────────────────────────────────────────

const PostsListPage: React.FC = () => {
  const { data, isLoading, error, refetch } = useQuery(
    () =>
      Promise.all([loadPostsList(), loadConsentPostsList(), getConfigs()]).then(
        ([announcements, forms, configs]) => ({
          rows: [...announcements, ...forms].map(withDateTs),
          configs,
        }),
      ),
    [],
  );
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = (searchParams.get('tab') as PostTab | null) ?? 'with-responses';
  const [filters, setFilters] = useState<PostFilters>(DEFAULT_POST_FILTERS);
  const [searchQuery, setSearchQuery] = useState('');
  const [sort, setSort] = useState<SortState | null>(null);
  const [scopeOpen, setScopeOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const posts = data?.rows ?? [];
  const configs: ApiConfig | undefined = data?.configs;

  const duplicateEnabled =
    configs?.flags.duplicate_announcement_form_post?.enabled === true ||
    (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true;

  const sorted = useMemo(() => {
    const rows = posts.filter((p) =>
      matchesPostFilters(p, { tab, query: searchQuery, ...filters }),
    );
    rows.sort(sort ? (a, b) => compareBySort(a, b, sort) || comparePosts(a, b) : comparePosts);
    return rows;
  }, [posts, searchQuery, tab, filters, sort]);

  const pagination = usePagination({ totalItems: sorted.length, pageSize: PAGE_SIZE });
  const paged = sorted.slice(pagination.startIndex, pagination.startIndex + PAGE_SIZE);

  // Selection is per-tab; switching tabs discards it.
  useEffect(() => {
    setSelectedIds(new Set());
  }, [tab]);

  const pagedSelectedCount = paged.filter((r) => selectedIds.has(r.id)).length;
  const allInViewSelected = paged.length > 0 && pagedSelectedCount === paged.length;
  const someInViewSelected = pagedSelectedCount > 0 && !allInViewSelected;

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const toggleSelectAllInView = useCallback(() => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allInViewSelected) {
        for (const row of paged) next.delete(row.id);
      } else {
        for (const row of paged) next.add(row.id);
      }
      return next;
    });
  }, [allInViewSelected, paged]);

  const filtersActive =
    filters.status.length > 0 ||
    filters.ownership.length > 0 ||
    filters.response.length > 0 ||
    filters.dateFrom != null ||
    filters.dateTo != null;

  const handleSort = useCallback((column: string, direction: SortDirection) => {
    setSort({ column, direction });
  }, []);

  const handleDuplicate = useCallback(
    (row: PostRowData) => {
      const isDraft = row.status === 'draft' || row.status === 'scheduled';
      const promise: Promise<number> =
        row.kind === 'announcement'
          ? (isDraft
              ? duplicateAnnouncementDraft(row.numericId)
              : duplicateAnnouncement(row.numericId)
            ).then((r) => r.announcementDraftId)
          : (isDraft
              ? duplicateConsentFormDraft(row.numericId)
              : duplicateConsentForm(row.numericId)
            ).then((r) => r.consentFormDraftId);

      promise
        .then((draftId) => {
          refetch();
          const href = duplicateDraftHref(row.kind, draftId);
          toast.success(`'${row.title}' has been duplicated.`, {
            action: { label: 'View draft', onClick: () => navigate(href) },
          });
        })
        .catch(() => {
          notify.error('Failed to duplicate post.');
        });
    },
    [refetch, navigate],
  );

  // Single delete
  const [pendingDelete, setPendingDelete] = useState<PostRowData | null>(null);
  const [deleting, setDeleting] = useState(false);

  const handleDelete = useCallback((row: PostRowData) => {
    setPendingDelete(row);
  }, []);

  const confirmDelete = useCallback(async () => {
    const row = pendingDelete;
    if (!row) return;
    setDeleting(true);
    try {
      await deletePostRow(row);
      refetch();
      notify.success('Post deleted.');
      setPendingDelete(null);
    } catch (err) {
      if (!(err instanceof NotFoundError)) {
        notify.error('Failed to delete post.');
      }
    } finally {
      setDeleting(false);
    }
  }, [pendingDelete, refetch]);

  // Bulk delete
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const selectedRows = useMemo(
    () => posts.filter((p) => selectedIds.has(p.id) && p.ownership !== 'shared'),
    [posts, selectedIds],
  );

  const confirmBulkDelete = useCallback(async () => {
    if (selectedRows.length === 0) return;
    setBulkDeleting(true);
    try {
      await Promise.all(selectedRows.map((row) => deletePostRow(row)));
      refetch();
      notify.success(
        selectedRows.length === 1 ? 'Post deleted.' : `${selectedRows.length} posts deleted.`,
      );
      setSelectedIds(new Set());
      setBulkDeleteOpen(false);
    } catch (err) {
      if (!(err instanceof NotFoundError)) {
        notify.error('Failed to delete posts.');
      }
    } finally {
      setBulkDeleting(false);
    }
  }, [selectedRows, refetch]);

  if (error) return <QueryError onRetry={refetch} />;
  if (isLoading) return null;

  return (
    <div className="flex flex-col">
      {/* Admin banner */}
      {IS_ADMIN && (
        <div className="flex items-center justify-center gap-2 border-b border-amber-6 bg-amber-2 px-6 py-2 text-sm text-amber-11">
          <Crown className="h-3.5 w-3.5 shrink-0 text-amber-9" />
          <span>
            <span className="font-semibold">You have admin access.</span> To view school posts, use
            the dropdown next to My Posts.
          </span>
        </div>
      )}

      {/* Page header */}
      <div className="px-6 pt-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            {IS_ADMIN ? (
              <Popover open={scopeOpen} onOpenChange={setScopeOpen}>
                <PopoverTrigger className="inline-flex cursor-pointer items-center gap-1.5 bg-transparent p-0 text-2xl font-semibold tracking-tight outline-none">
                  My Posts
                  <ChevronDown className="h-5 w-5 text-muted-foreground" />
                </PopoverTrigger>
                <PopoverContent
                  align="start"
                  className="w-56 gap-0 overflow-hidden rounded-2xl p-1"
                >
                  <button
                    type="button"
                    onClick={() => setScopeOpen(false)}
                    className="flex w-full flex-col rounded-xl bg-accent px-3 py-2 text-left"
                  >
                    <span className="flex items-center justify-between">
                      <span className="text-sm font-medium">My posts</span>
                      <Check className="h-4 w-4 text-primary" />
                    </span>
                    <span className="text-xs text-muted-foreground">Posts you created</span>
                  </button>
                  <button
                    type="button"
                    disabled
                    className="flex w-full cursor-not-allowed flex-col rounded-xl px-3 py-2 text-left opacity-50"
                  >
                    <span className="text-sm font-medium">School posts</span>
                    <span className="text-xs text-muted-foreground">Coming soon</span>
                  </button>
                </PopoverContent>
              </Popover>
            ) : (
              <h1 className="text-2xl font-semibold tracking-tight">My Posts</h1>
            )}
            <p className="mt-1 text-sm text-muted-foreground">
              Send posts to parents via Parents Gateway. Choose whether parents need to respond.
            </p>
          </div>
          <Button variant="default" size="sm" render={<Link to="new" />} nativeButton={false}>
            <Plus className="h-4 w-4" />
            Create
          </Button>
        </div>
      </div>

      {/* Toolbar: tabs + selection actions + search/filter */}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-b px-6 pb-4">
        <Tabs value={tab} onValueChange={(v) => setSearchParams({ tab: v }, { replace: true })}>
          <TabsList>
            <TabsTrigger value="with-responses">Response Required</TabsTrigger>
            <TabsTrigger value="view-only">Read Only</TabsTrigger>
          </TabsList>
        </Tabs>

        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="text"
              placeholder="Search posts..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full min-w-[220px] pl-9 sm:w-[280px]"
              aria-label="Search posts"
            />
          </div>
          <PostFilterPopover
            value={filters}
            onChange={setFilters}
            responseOptions={
              tab === 'view-only'
                ? null
                : [
                    { value: 'acknowledge', label: 'Acknowledge' },
                    { value: 'yes-no', label: 'Yes / No' },
                  ]
            }
          />
        </div>
      </div>

      {/* Table */}
      <div className="max-w-full overflow-x-auto">
        {sorted.length === 0 ? (
          <div className="py-16 text-center">
            {searchQuery ? (
              <>
                <p className="text-base text-foreground">No posts match your search.</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Try adjusting your search terms.
                </p>
              </>
            ) : filtersActive ? (
              <>
                <p className="text-base text-foreground">No posts match these filters.</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Loosen a filter or reset them to see more posts.
                </p>
                <Button
                  variant="secondary"
                  size="sm"
                  className="mt-4"
                  onClick={() => setFilters(DEFAULT_POST_FILTERS)}
                >
                  Reset filters
                </Button>
              </>
            ) : (
              <>
                <p className="text-base text-foreground">No posts yet.</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Create your first post to get started.
                </p>
                <Button
                  variant="default"
                  size="sm"
                  className="mt-4"
                  render={<Link to="/posts/new" />}
                  nativeButton={false}
                >
                  <Plus className="h-4 w-4" />
                  Create
                </Button>
              </>
            )}
          </div>
        ) : (
          <>
            <Table tableClassName="w-full table-fixed">
              <TableHeader className="border-b bg-background">
                <TableRow className="border-0 hover:bg-transparent">
                  <TableHead className="sticky left-0 z-10 w-[44px] bg-background pl-6">
                    <Checkbox
                      indeterminate={someInViewSelected}
                      checked={allInViewSelected}
                      onCheckedChange={toggleSelectAllInView}
                      aria-label="Select all"
                    />
                  </TableHead>
                  <TableHead className="sticky left-[44px] z-10 w-[360px] bg-background pl-2">
                    <SortableHeader label="Title" column="title" sort={sort} onSort={handleSort} />
                  </TableHead>
                  <TableHead className="w-[140px]">
                    <SortableHeader label="Date" column="date" sort={sort} onSort={handleSort} />
                  </TableHead>
                  <TableHead className="w-[110px]">
                    <SortableHeader
                      label="Status"
                      column="status"
                      sort={sort}
                      onSort={handleSort}
                    />
                  </TableHead>
                  <TableHead className="w-[150px]">
                    {tab === 'with-responses' ? 'Response' : 'Read'}
                  </TableHead>
                  <TableHead className="w-[180px]">To parents of</TableHead>
                  <TableHead className="w-[130px]">
                    <SortableHeader
                      label="Created by"
                      column="created-by"
                      sort={sort}
                      onSort={handleSort}
                    />
                  </TableHead>
                  <TableHead className="w-[80px]">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paged.map((row) => (
                  <PostTableRow
                    key={row.id}
                    row={row}
                    selected={selectedIds.has(row.id)}
                    duplicateEnabled={duplicateEnabled}
                    onToggleSelect={toggleSelect}
                    onDuplicate={handleDuplicate}
                    onDelete={handleDelete}
                  />
                ))}
              </TableBody>
            </Table>

            {/* Pagination */}
            <div className="flex items-center justify-between px-6 py-4">
              <p className="text-sm text-muted-foreground">
                {pagination.startIndex + 1}–
                {Math.min(pagination.startIndex + PAGE_SIZE, sorted.length)} of {sorted.length}{' '}
                records
              </p>
              {pagination.totalPages > 1 && (
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={pagination.goToPreviousPage}
                    disabled={!pagination.canGoPrevious}
                  >
                    <ChevronLeft className="h-4 w-4" />
                    Previous
                  </Button>
                  {pagination.pageNumbers.map((page, index) =>
                    page === 'ellipsis' ? (
                      <span key={`ellipsis-${index}`} className="px-2 text-muted-foreground">
                        ...
                      </span>
                    ) : (
                      <Button
                        key={page}
                        variant={pagination.currentPage === page ? 'secondary' : 'ghost'}
                        size="icon-sm"
                        onClick={() => pagination.goToPage(page)}
                      >
                        {page}
                      </Button>
                    ),
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={pagination.goToNextPage}
                    disabled={!pagination.canGoNext}
                  >
                    Next
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Floating selection bar */}
      {selectedIds.size > 0 && (
        <div className="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1 rounded-full border bg-background py-1.5 pr-2 pl-4 shadow-lg">
          <span className="text-sm font-medium whitespace-nowrap">{selectedIds.size} selected</span>
          <Button variant="ghost" size="sm" onClick={() => setSelectedIds(new Set())}>
            Clear
          </Button>
          <Button
            variant="destructive"
            size="sm"
            className="rounded-full"
            disabled={selectedRows.length === 0}
            onClick={() => setBulkDeleteOpen(true)}
          >
            <Trash2 className="h-4 w-4" />
            Delete {selectedRows.length} {selectedRows.length === 1 ? 'post' : 'posts'}
          </Button>
        </div>
      )}

      <DeletePostDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        items={pendingDelete ? [toDeleteDialogItem(pendingDelete)] : []}
        pending={deleting}
        onConfirm={confirmDelete}
      />

      <DeletePostDialog
        open={bulkDeleteOpen}
        onOpenChange={setBulkDeleteOpen}
        items={selectedRows.map(toDeleteDialogItem)}
        pending={bulkDeleting}
        onConfirm={confirmBulkDelete}
      />
    </div>
  );
};

// ─── Row ────────────────────────────────────────────────────────────────────

interface PostTableRowProps {
  row: PostRowData;
  selected: boolean;
  duplicateEnabled: boolean;
  onToggleSelect: (id: string) => void;
  onDuplicate: (row: PostRowData) => void;
  onDelete: (row: PostRowData) => void;
}

const PostTableRow: React.FC<PostTableRowProps> = ({
  row,
  selected,
  duplicateEnabled,
  onToggleSelect,
  onDuplicate,
  onDelete,
}) => {
  const navigate = useNavigate();
  const isShared = row.ownership === 'shared';

  const statusBadge = getPostStatusBadge(row);

  const showLowRead =
    row.kind === 'announcement' &&
    row.status === 'posted' &&
    isLowReadRate(row.postedAt, row.stats.readCount, row.stats.totalCount);

  const hasSendFailure = Boolean(row.scheduledSendFailureCode);
  const clickable = (row.status !== 'scheduled' && row.status !== 'posting') || hasSendFailure;
  const goToEdit = row.status === 'draft' || hasSendFailure;

  const counts = responseCounts(row);
  const classLabels = classLabelsFor(row);

  return (
    <TableRow
      className={cn(
        clickable ? 'cursor-pointer' : 'cursor-default',
        selected && 'bg-primary/[0.04] hover:bg-primary/[0.06]',
      )}
      onClick={clickable ? () => navigate(postHref(row, { edit: goToEdit })) : undefined}
    >
      <TableCell
        className="sticky left-0 z-10 w-[44px] bg-background pl-6"
        onClick={(e) => e.stopPropagation()}
      >
        <Checkbox
          checked={selected}
          onCheckedChange={() => onToggleSelect(row.id)}
          aria-label={`Select ${row.title}`}
        />
      </TableCell>
      <TableCell className="sticky left-[44px] z-10 overflow-hidden bg-background pl-2 whitespace-normal">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="truncate font-medium">{row.title}</span>
            {row.responseType === 'acknowledge' && (
              <span className="shrink-0 rounded-full bg-twblue-3 px-1.5 py-0.5 text-[10px] font-medium text-twblue-11 ring-1 ring-twblue-6 ring-inset">
                Acknowledge
              </span>
            )}
            {row.responseType === 'yes-no' && (
              <span className="shrink-0 rounded-full bg-violet-3 px-1.5 py-0.5 text-[10px] font-medium text-violet-11 ring-1 ring-violet-6 ring-inset">
                Yes/No
              </span>
            )}
            {showLowRead && (
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-warning-foreground" />
            )}
          </div>
        </div>
      </TableCell>
      <TableCell>
        {row._date ? (
          <div className="flex flex-col">
            <span className="text-xs text-muted-foreground">{dateLabel(row.status)}</span>
            <span className="text-sm text-foreground">{formatDate(row._date)}</span>
          </div>
        ) : (
          <span className="text-sm text-muted-foreground">{'—'}</span>
        )}
      </TableCell>
      <TableCell>
        <Badge variant={statusBadge.variant}>{statusBadge.label}</Badge>
      </TableCell>
      <TableCell className="pr-6">
        {counts ? (
          <ReadRateBar readCount={counts.count} totalCount={counts.total} />
        ) : (
          <span className="text-sm text-muted-foreground">{'—'}</span>
        )}
      </TableCell>
      <TableCell>
        {classLabels ? (
          <span className="line-clamp-2 text-sm whitespace-normal text-muted-foreground">
            {classLabels}
          </span>
        ) : (
          <span className="text-sm text-muted-foreground">{'—'}</span>
        )}
      </TableCell>
      <TableCell>
        <span className="truncate text-sm text-muted-foreground">{createdByLabel(row)}</span>
      </TableCell>
      <TableCell onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-start">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-muted-foreground hover:text-foreground"
                  aria-label="More actions"
                />
              }
            >
              <MoreHorizontal className="h-4 w-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {duplicateEnabled && (
                <DropdownMenuItem
                  onClick={(e) => {
                    e.stopPropagation();
                    onDuplicate(row);
                  }}
                >
                  <Copy className="mr-2 h-4 w-4" />
                  Duplicate
                </DropdownMenuItem>
              )}
              {!isShared && (
                <>
                  {duplicateEnabled && <DropdownMenuSeparator />}
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    onClick={(e) => {
                      e.stopPropagation();
                      void onDelete(row);
                    }}
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    Delete
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </TableCell>
    </TableRow>
  );
};

export { PostsListPage };
