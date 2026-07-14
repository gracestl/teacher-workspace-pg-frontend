import {
  AlertCircle,
  ArrowLeft,
  CalendarClock,
  Eye,
  EyeOff,
  Info,
  Lock,
  Plus,
  Save,
  Send,
  X,
} from 'lucide-react';
import { useDeferredValue, useMemo, useReducer, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router';

import { QueryError } from '~/components/QueryError';
import {
  Button,
  Card,
  CardContent,
  Input,
  Label,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Separator,
} from '~/components/ui';
import { describeScheduledSendFailure, type Post } from '~/data/posts-registry';
import {
  createAnnouncement,
  createDraft,
  loadAnnouncementDraftDetail,
  loadPostDetail,
  scheduleExistingAnnouncementDraft,
  scheduleNewAnnouncementDraft,
  updateAnnouncementEnquiryEmail,
  updateAnnouncementStaffInCharge,
  updateDraft,
} from '~/features/posts/api/announcements';
import {
  createConsentForm,
  createConsentFormDraft,
  loadConsentFormDraftDetail,
  loadConsentPostDetail,
  scheduleExistingConsentFormDraft,
  scheduleNewConsentFormDraft,
  updateConsentFormDraft,
  updateConsentFormDueDate,
  updateConsentFormEnquiryEmail,
  updateConsentFormStaffInCharge,
} from '~/features/posts/api/consent-forms';
import { AppError, ValidationError } from '~/features/posts/api/errors';
import {
  buildAnnouncementPayload,
  buildConsentFormPayload,
  type BuildPostPayloadInput,
} from '~/features/posts/api/mappers';
import {
  fetchSchoolClasses,
  fetchSchoolStaff,
  fetchSchoolStaffGroups,
  fetchSchoolStudents,
} from '~/features/posts/api/school';
import { fetchSession, getConfigs } from '~/features/posts/api/session';
import type {
  ApiConfig,
  ApiSchoolClass,
  ApiSchoolStaff,
  ApiSchoolStudent,
  ApiSession,
  ApiStaffGroups,
} from '~/features/posts/api/types';
import { AttachmentSection } from '~/features/posts/components/AttachmentSection';
import { DueDateSection } from '~/features/posts/components/DueDateSection';
import { EnquiryEmailSelector } from '~/features/posts/components/EnquiryEmailSelector';
import type {
  GroupType as SelectorGroupType,
  SelectedEntity as SelectorEntity,
} from '~/features/posts/components/EntitySelector';
import { EventScheduleSection } from '~/features/posts/components/EventScheduleSection';
import { PostPreview } from '~/features/posts/components/PostPreview';
import { PostTypePicker, type PostKind } from '~/features/posts/components/PostTypePicker';
import { MAX_QUESTIONS, QuestionBuilder } from '~/features/posts/components/QuestionBuilder';
import { ReminderSection } from '~/features/posts/components/ReminderSection';
import { ResponseTypeSelector } from '~/features/posts/components/ResponseTypeSelector';
import { RichTextEditor } from '~/features/posts/components/RichTextEditor';
import {
  SchedulePickerDialog,
  type ScheduleWindow,
} from '~/features/posts/components/SchedulePickerDialog';
import { SendConfirmationDialog } from '~/features/posts/components/SendConfirmationDialog';
import { ShortcutsSection } from '~/features/posts/components/ShortcutsSection';
import { StaffSearchSelector } from '~/features/posts/components/StaffSearchSelector';
import { StudentRecipientSelector } from '~/features/posts/components/StudentRecipientSelector';
import { VenueSection } from '~/features/posts/components/VenueSection';
import { WebsiteLinksSection } from '~/features/posts/components/WebsiteLinksSection';
import { useAutoSave, type AutoSaveStatus } from '~/features/posts/hooks/useAutoSave';
import { useUnsavedChangesGuard } from '~/features/posts/hooks/useUnsavedChangesGuard';
import { INITIAL_STATE, type SelectedEntity } from '~/features/posts/state/initial-state';
import { formReducer } from '~/features/posts/state/reducer';
import {
  DESCRIPTION_MAX_LENGTH,
  TITLE_MAX_LENGTH,
  computeInlineErrors,
  hasPendingUploads,
  isCreatePostFormValid,
  type PostKind as ValidationPostKind,
} from '~/features/posts/validation/create-post-validation';
import { textToTiptapDoc } from '~/helpers/tiptap';
import { useQuery } from '~/hooks/useQuery';
import { notify } from '~/lib/notify';
import { cn, stripSalutation } from '~/lib/utils';
import {
  fieldForValidationError,
  reportValidationError,
  type PostFormField,
} from '~/lib/validation-errors';

// ─── Types ──────────────────────────────────────────────────────────────────

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseScheduleWindow(raw: unknown): ScheduleWindow | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const maybe = raw as { start?: unknown; end?: unknown };
  if (typeof maybe.start !== 'string' || typeof maybe.end !== 'string') return undefined;
  if (!/^\d{2}:\d{2}$/.test(maybe.start) || !/^\d{2}:\d{2}$/.test(maybe.end)) return undefined;
  return { start: maybe.start, end: maybe.end };
}

function sgtIsoToLocalDateTime(iso: string): string {
  const d = new Date(iso);
  const sgt = d.toLocaleString('sv-SE', {
    timeZone: 'Asia/Singapore',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return sgt.replace(' ', 'T');
}

function sgtIsoToLocalDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Singapore' });
}

const MAX_WEBSITE_LINKS = 3;

function postToFormState(
  post: Post,
  staff: ApiSchoolStaff[],
  classes: ApiSchoolClass[],
  students: ApiSchoolStudent[],
): typeof INITIAL_STATE {
  // Build class-id → roster size lookup
  const studentsByClass = new Map<string, number>();
  for (const s of students) {
    const stripped = s.className.replace(/ \(\d{4}\)$/, '');
    studentsByClass.set(stripped, (studentsByClass.get(stripped) ?? 0) + 1);
  }
  const classRosterById = new Map<number, number>();
  for (const c of classes) {
    classRosterById.set(c.value, studentsByClass.get(c.label.replace(/ \(\d{4}\)$/, '')) ?? 0);
  }

  const selectedRecipients: SelectedEntity[] = (post.targets ?? []).map((t) => ({
    id: t.id.toString(),
    label: t.label,
    type: 'group',
    count: t.type === 'class' ? (classRosterById.get(t.id) ?? 0) : 0,
    groupType:
      t.type === 'class'
        ? 'class'
        : t.type === 'group'
          ? 'custom'
          : t.type === 'cca'
            ? 'cca'
            : 'level',
  }));

  const byStaffId = new Map(staff.map((s) => [s.staffId, s]));
  const selectedStaff: SelectedEntity[] =
    post.staffOwnerIds && post.staffOwnerIds.length > 0
      ? post.staffOwnerIds.map((id) => {
          const s = byStaffId.get(id);
          return s
            ? {
                id: s.staffId.toString(),
                label: stripSalutation(s.name),
                type: 'individual',
                count: 1,
              }
            : { id: id.toString(), label: 'Unknown staff', type: 'individual', count: 1 };
        })
      : post.staffInCharge
        ? staff
            .filter((s) => s.name === post.staffInCharge)
            .map((s) => ({
              id: s.staffId.toString(),
              label: stripSalutation(s.name),
              type: 'individual',
              count: 1,
            }))
        : [];

  const common = {
    title: post.title,
    description: post.description,
    descriptionDoc: post.richTextContent ?? textToTiptapDoc(post.description),
    selectedRecipients,
    selectedStaff,
    enquiryEmail: post.enquiryEmail ?? '',
    websiteLinks: (post.websiteLinks ?? []).slice(0, MAX_WEBSITE_LINKS),
    shortcuts: [] as string[],
    attachments: (post.attachments ?? []).map((f) => ({
      ...f,
    })) as (typeof INITIAL_STATE)['attachments'],
    photos: (post.photos ?? []).map((p) => ({ ...p })) as (typeof INITIAL_STATE)['photos'],
  };

  if (post.kind === 'form') {
    const dueDateRaw = post.consentByDate
      ? new Date(post.consentByDate) < new Date()
        ? ''
        : sgtIsoToLocalDate(post.consentByDate)
      : '';
    return {
      ...INITIAL_STATE,
      ...common,
      kind: 'form' as const,
      responseType: post.responseType,
      questions: post.questions,
      dueDate: dueDateRaw,
      reminder:
        post.reminder.type === 'NONE'
          ? { type: 'NONE' as const }
          : { type: post.reminder.type, date: sgtIsoToLocalDate(post.reminder.date) },
      event: post.event
        ? {
            start: sgtIsoToLocalDateTime(post.event.start),
            end: sgtIsoToLocalDateTime(post.event.end),
            ...(post.event.venue && { venue: post.event.venue }),
          }
        : undefined,
      venue: post.event?.venue ?? '',
    };
  }

  // announcement
  return {
    ...INITIAL_STATE,
    ...common,
    kind: 'announcement' as const,
    responseType: post.responseType,
    questions: post.questions ?? [],
    dueDate: post.dueDate ?? '',
    reminder: { type: 'NONE' as const },
    event: undefined,
    venue: '',
  };
}

function editorHasContent(doc: typeof INITIAL_STATE.descriptionDoc): boolean {
  if (!doc || typeof doc !== 'object') return false;
  const content = (doc as { content?: unknown[] }).content;
  return Array.isArray(content) && content.length > 0;
}

/**
 * Coerce `PostFormState` to `BuildPostPayloadInput`. The only mismatch is
 * `SelectedEntity.id: string | number` vs the mapper's `id: string`, so we
 * stringify ids at the boundary.
 */
function stateToPayloadInput(state: typeof INITIAL_STATE): BuildPostPayloadInput {
  return {
    ...state,
    selectedRecipients: state.selectedRecipients.map((r) => ({
      ...r,
      id: String(r.id),
    })),
    selectedStaff: state.selectedStaff.map((s) => ({
      ...s,
      id: String(s.id),
    })),
  };
}

/**
 * Narrow the PostTypePicker's `PostKind` to the ValidationPostKind shape.
 * The picker uses 'post' | 'post-with-response'; validation uses
 * 'announcement' | 'post-with-response'. Both accept null.
 */
function toValidationKind(kind: PostKind | null): ValidationPostKind | null {
  if (kind === null) return null;
  if (kind === 'post-with-response') return 'post-with-response';
  // 'post' → 'announcement'
  return 'announcement';
}

// ─── Inner component ─────────────────────────────────────────────────────────

interface CreatePostPageInnerProps {
  editId?: string;
  postKind: 'announcement' | 'form';
  draft: boolean;
}

interface CreatePostLoaderData {
  detail: Post | null;
  classes: ApiSchoolClass[];
  staff: ApiSchoolStaff[];
  staffGroups: ApiStaffGroups;
  students: ApiSchoolStudent[];
  session: ApiSession;
  configs: ApiConfig;
}

/** Widen loose form-state entities into the EntitySelector's stricter shape. */
function toSelectorEntities(entities: SelectedEntity[]): SelectorEntity[] {
  return entities.map((e) => ({
    id: String(e.id),
    label: e.label,
    type: e.type === 'individual' ? ('individual' as const) : ('group' as const),
    count: e.count ?? 1,
    groupType: e.groupType as SelectorGroupType | undefined,
    memberNames: e.memberNames,
    excludedMemberNames: e.excludedMemberNames,
  }));
}

function CreatePostPageInner({ editId, postKind, draft }: CreatePostPageInnerProps) {
  const {
    data: loaderData,
    isLoading,
    error,
    refetch,
  } = useQuery(() => {
    let detailPromise: Promise<Post | null> = Promise.resolve(null);
    if (editId && /^\d+$/.test(editId)) {
      const numericId = Number(editId);
      if (postKind === 'form') {
        detailPromise = draft
          ? loadConsentFormDraftDetail(numericId)
          : loadConsentPostDetail(numericId);
      } else {
        detailPromise = draft ? loadAnnouncementDraftDetail(numericId) : loadPostDetail(numericId);
      }
    }
    return Promise.all([
      detailPromise,
      fetchSchoolClasses(),
      fetchSchoolStaff(),
      fetchSchoolStaffGroups().catch(() => ({ level: [], school: [] }) as ApiStaffGroups),
      fetchSchoolStudents(),
      fetchSession(),
      getConfigs(),
    ]).then(([detail, classes, staff, staffGroups, students, session, configs]) => ({
      detail,
      classes,
      staff,
      staffGroups,
      students,
      session,
      configs,
    }));
  }, [editId, postKind, draft]);

  if (error) return <QueryError onRetry={refetch} />;

  if (isLoading || !loaderData) return null;

  return <CreatePostForm editId={editId} loaderData={loaderData} />;
}

interface CreatePostFormProps {
  editId?: string;
  loaderData: CreatePostLoaderData;
}

function CreatePostForm({ editId, loaderData }: CreatePostFormProps) {
  const navigate = useNavigate();
  const { detail, classes, staff, students, session, configs } = loaderData;

  const scheduleEnabled = configs.flags.schedule_announcement_form_post?.enabled === true;
  const declareTravelsEnabled = configs.flags.absence_submission?.enabled === true;
  const editContactEnabled = true;
  const scheduleWindow = parseScheduleWindow(configs.configs.schedule_window);

  const [showSendDialog, setShowSendDialog] = useState(false);
  const [showScheduleDialog, setShowScheduleDialog] = useState(false);
  // Set between schedule step 1 (picker) and step 2 (review). Null for post-now.
  const [pendingScheduledAt, setPendingScheduledAt] = useState<string | null>(null);
  const [fileBannerDismissed, setFileBannerDismissed] = useState(false);
  // Open by default only when the side-by-side layout has room (lg+). On
  // narrower viewports the preview is a slide-over drawer that would cover
  // the form, so it starts closed and opens via the header toggle.
  const [showPreview, setShowPreview] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches,
  );
  const [focusSection, setFocusSection] = useState<
    'header' | 'content' | 'attachments' | 'links' | 'questions' | 'response'
  >('header');
  const [focusedQuestionIndex, setFocusedQuestionIndex] = useState(0);
  const [saveState, setSaveState] = useState<'idle' | 'submitting' | 'submitted'>('idle');
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<PostFormField, string>>>({});

  const clearFieldError = (field: PostFormField) =>
    setFieldErrors((prev) => {
      if (!(field in prev)) return prev;
      const { [field]: _removed, ...rest } = prev;
      return rest;
    });

  const stampValidationError = (err: ValidationError): boolean => {
    const field = fieldForValidationError(err);
    if (!field) return false;
    setFieldErrors((prev) => ({ ...prev, [field]: reportValidationError(err) }));
    return true;
  };

  const isSaving = saveState !== 'idle';

  const emailOptions = useMemo(
    () =>
      [session.staffEmailAdd, session.schoolEmailAddress].filter((e): e is string => Boolean(e)),
    [session.staffEmailAdd, session.schoolEmailAddress],
  );

  const [selectedType, setSelectedType] = useState<PostKind | null>(() => {
    if (!editId) return null;
    if (detail?.kind === 'form') return 'post-with-response';
    if (detail && (detail.responseType === 'acknowledge' || detail.responseType === 'yes-no')) {
      return 'post-with-response';
    }
    return 'post';
  });

  const editData = detail ? postToFormState(detail, staff, classes, []) : null;
  const [state, dispatch] = useReducer(formReducer, editData ?? INITIAL_STATE);

  const initialDescriptionDocRef = useRef(state.descriptionDoc);
  const initialDescriptionDoc = initialDescriptionDocRef.current;

  const deferredState = useDeferredValue(state);

  const isFormValid = isCreatePostFormValid(state, toValidationKind(selectedType));
  const uploadsPending = hasPendingUploads(state);

  const [showValidationPopover, setShowValidationPopover] = useState(false);
  const FIELD_LABELS: Record<PostFormField, string> = {
    title: 'Add a title',
    description: 'Write the post details',
    enquiryEmail: 'Select an enquiry email',
    recipients: 'Select at least one recipient',
    dueDate: 'Set a due date for responses',
  };
  const missingFieldLabels = (Object.keys(fieldErrors) as PostFormField[]).map(
    (k) => FIELD_LABELS[k],
  );

  const recipientCount = state.selectedRecipients.reduce(
    (sum, r) => sum + Math.max((r.count ?? 1) - (r.excludedMemberNames?.length ?? 0), 0),
    0,
  );

  // Chips shown in the send/schedule review — same labels and counts as the
  // compose page, minus any per-member exclusions.
  const recipientGroups = useMemo(
    () =>
      state.selectedRecipients.map((r) => ({
        label: r.label,
        count: Math.max((r.count ?? 1) - (r.excludedMemberNames?.length ?? 0), 0),
      })),
    [state.selectedRecipients],
  );

  // "2 files and 1 photo" — media loaded back from a saved draft, for the
  // 30-day retention banner. Empty string when the draft has no media.
  const draftMediaLabel = useMemo(() => {
    const fileCount = state.attachments.filter((f) => f.status === 'ready').length;
    const photoCount = state.photos.filter((p) => p.status === 'ready').length;
    return [
      fileCount > 0 ? `${fileCount} file${fileCount > 1 ? 's' : ''}` : '',
      photoCount > 0 ? `${photoCount} photo${photoCount > 1 ? 's' : ''}` : '',
    ]
      .filter(Boolean)
      .join(' and ');
  }, [state.attachments, state.photos]);
  const isEditing = Boolean(editId);
  const isPostedEdit =
    isEditing &&
    Boolean(
      detail &&
      (detail.status === 'posted' ||
        detail.status === 'open' ||
        detail.status === 'closed' ||
        detail.status === 'posting'),
    );

  const isFailedScheduledEdit =
    isEditing &&
    Boolean(detail && detail.status === 'scheduled' && detail.scheduledSendFailureCode);
  const failedScheduledReason = isFailedScheduledEdit
    ? describeScheduledSendFailure(detail?.scheduledSendFailureCode)
    : null;

  const draftIdRef = useRef<{ kind: 'announcement' | 'form'; id: number } | null>(
    editId && detail
      ? { kind: detail.kind === 'form' ? 'form' : 'announcement', id: detail.numericId }
      : null,
  );

  const autoSave = useAutoSave({
    payload: state,
    save: async (_snapshot, { signal }) => {
      await handleSaveDraft({ signal });
    },
    intervalMs: 30_000,
    enabled: !isSaving,
    shouldSave: (s) => s.title.trim().length > 0 || editorHasContent(s.descriptionDoc),
  });

  const isDirty =
    autoSave.lastSavedSerialized !== null
      ? JSON.stringify(state) !== autoSave.lastSavedSerialized
      : state.title.trim().length > 0 || editorHasContent(state.descriptionDoc);

  useUnsavedChangesGuard(isDirty);

  if (editId && !editData) {
    return <Navigate to=".." replace />;
  }

  function handlePostClick() {
    if (!isFormValid) {
      setFieldErrors(computeInlineErrors(state, toValidationKind(selectedType)));
      setShowValidationPopover(true);
      return;
    }
    setPendingScheduledAt(null);
    setShowSendDialog(true);
  }

  /** Schedule step 1 → step 2: stash the picked time, swap dialogs. */
  function handleScheduleContinue(scheduledSendAt: string) {
    setPendingScheduledAt(scheduledSendAt);
    setShowScheduleDialog(false);
    setShowSendDialog(true);
  }

  function handleScheduleClick() {
    if (!isFormValid) {
      setFieldErrors(computeInlineErrors(state, toValidationKind(selectedType)));
      setShowValidationPopover(true);
      return;
    }
    setShowScheduleDialog(true);
  }

  function handleTypeSelect(type: PostKind) {
    setSelectedType(type);
    const kind = type === 'post-with-response' ? 'form' : 'announcement';
    dispatch({ type: 'SET_KIND', payload: kind });
    if (type === 'post-with-response') {
      dispatch({ type: 'SET_RESPONSE_TYPE', payload: 'acknowledge' });
    }
  }

  async function handleSaveDraft(opts: { signal?: AbortSignal } = {}): Promise<void> {
    try {
      const payloadInput = stateToPayloadInput(state);
      if (state.kind === 'form') {
        const payload = buildConsentFormPayload(payloadInput);
        if (draftIdRef.current?.kind === 'form') {
          await updateConsentFormDraft(draftIdRef.current.id, payload, { signal: opts.signal });
        } else {
          const { consentFormDraftId } = await createConsentFormDraft(payload, {
            signal: opts.signal,
          });
          draftIdRef.current = { kind: 'form', id: consentFormDraftId };
        }
      } else {
        const payload = buildAnnouncementPayload(payloadInput);
        if (draftIdRef.current?.kind === 'announcement') {
          await updateDraft(draftIdRef.current.id, payload, { signal: opts.signal });
        } else {
          const { announcementDraftId } = await createDraft(payload, { signal: opts.signal });
          draftIdRef.current = { kind: 'announcement', id: announcementDraftId };
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (err instanceof ValidationError) {
        notify.error(reportValidationError(err));
      } else if (err instanceof Error && !(err instanceof AppError)) {
        notify.error(err.message);
      } else if (!(err instanceof AppError)) {
        notify.error('Failed to save draft.');
      }
      throw err;
    }
  }

  async function handleSavePostedEdit() {
    if (!detail || saveState !== 'idle') return;
    setSaveState('submitting');
    try {
      const staffIds = state.selectedStaff.map((s) => Number(s.id));
      const email = state.enquiryEmail ?? '';
      if (detail.kind === 'announcement') {
        await Promise.all([
          updateAnnouncementEnquiryEmail(detail.numericId, { enquiryEmailAddress: email }),
          updateAnnouncementStaffInCharge(detail.numericId, staffIds),
        ]);
      } else {
        const consentByDate = state.dueDate.trim() ? `${state.dueDate}T23:59:59+08:00` : '';
        await Promise.all([
          updateConsentFormEnquiryEmail(detail.numericId, { enquiryEmailAddress: email }),
          updateConsentFormStaffInCharge(detail.numericId, staffIds),
          ...(consentByDate ? [updateConsentFormDueDate(detail.numericId, { consentByDate })] : []),
        ]);
      }
      notify.success('Changes saved.');
      navigate(-1);
    } catch {
      notify.error('Failed to save. Please try again.');
    } finally {
      setSaveState('idle');
    }
  }

  async function handleScheduleConfirm(scheduledSendAt: string) {
    if (saveState !== 'idle') return;
    setShowScheduleDialog(false);
    setShowSendDialog(false);
    setPendingScheduledAt(null);
    setSaveState('submitting');
    try {
      const payloadInput = stateToPayloadInput(state);
      if (state.kind === 'form') {
        const draftPayload = { ...buildConsentFormPayload(payloadInput), scheduledSendAt };
        if (isEditing && detail?.kind === 'form' && detail.numericId) {
          await scheduleExistingConsentFormDraft(detail.numericId, draftPayload);
        } else {
          await scheduleNewConsentFormDraft(draftPayload);
        }
      } else {
        const draftPayload = { ...buildAnnouncementPayload(payloadInput), scheduledSendAt };
        if (draftIdRef.current?.kind === 'announcement') {
          await scheduleExistingAnnouncementDraft(draftIdRef.current.id, draftPayload);
        } else {
          await scheduleNewAnnouncementDraft(draftPayload);
        }
      }
      setSaveState('submitted');
      notify.success('Post scheduled.');
      navigate('..');
    } catch (err) {
      setSaveState('idle');
      if (err instanceof ValidationError) {
        const stamped = stampValidationError(err);
        if (!stamped) notify.error(reportValidationError(err));
      } else if (!(err instanceof AppError)) {
        notify.error('Failed to schedule post. Please try again.');
      }
    }
  }

  async function handleSendConfirm() {
    if (saveState !== 'idle') return;
    setShowSendDialog(false);
    setSaveState('submitting');
    try {
      const payloadInput = stateToPayloadInput(state);
      if (state.kind === 'form') {
        await createConsentForm(buildConsentFormPayload(payloadInput));
      } else {
        await createAnnouncement(buildAnnouncementPayload(payloadInput));
      }
      setSaveState('submitted');
      notify.success('Post sent.');
      navigate('..');
    } catch (err) {
      setSaveState('idle');
      if (err instanceof ValidationError) {
        const stamped = stampValidationError(err);
        if (!stamped) notify.error(reportValidationError(err));
      } else if (err instanceof Error && !(err instanceof AppError)) {
        notify.error(err.message);
      } else if (!(err instanceof AppError)) {
        notify.error('Failed to send post. Please try again.');
      }
    }
  }

  if (!selectedType) {
    return (
      <div className="flex flex-col">
        <div className="sticky top-0 z-10 border-b bg-white/95 px-6 py-3 backdrop-blur-sm">
          <div className="flex items-center gap-3">
            <Link to=".." className="text-muted-foreground hover:text-foreground">
              <ArrowLeft className="h-5 w-5" />
            </Link>
            <h1 className="text-xl font-semibold tracking-tight">New Post</h1>
          </div>
        </div>
        <PostTypePicker onSelect={handleTypeSelect} />
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {/* Header */}
      <div className="sticky top-0 z-10 border-b bg-white/95 px-6 py-3 backdrop-blur-sm">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Link to=".." className="text-muted-foreground hover:text-foreground">
              <ArrowLeft className="h-5 w-5" />
            </Link>
            <h1 className="text-xl font-semibold tracking-tight">
              {isEditing ? 'Edit Post' : 'New Post'}
            </h1>
          </div>

          <div className="flex items-center gap-3">
            {isPostedEdit ? (
              <Button
                variant="default"
                size="sm"
                disabled={isSaving}
                onClick={() => void handleSavePostedEdit()}
              >
                <Save className="mr-1.5 h-4 w-4" />
                {isSaving ? 'Saving…' : 'Save changes'}
              </Button>
            ) : (
              <>
                <SaveStatusTicker status={autoSave.status} lastSavedAt={autoSave.lastSavedAt} />
                <Button variant="ghost" size="sm" onClick={() => setShowPreview((s) => !s)}>
                  {showPreview ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
                <Popover open={showValidationPopover} onOpenChange={setShowValidationPopover}>
                  <PopoverTrigger
                    render={
                      <Button
                        variant="default"
                        size="sm"
                        disabled={isSaving}
                        onClick={handlePostClick}
                        className={cn(
                          !isFormValid && '!bg-muted !text-muted-foreground/40 hover:!bg-muted',
                        )}
                      >
                        <Send className="mr-1.5 h-4 w-4" />
                        Post now
                      </Button>
                    }
                  />
                  <PopoverContent side="top" align="end" className="w-64 space-y-2 p-4">
                    <p className="text-sm font-semibold">Complete these fields before posting</p>
                    <ul className="space-y-1">
                      {missingFieldLabels.map((label) => (
                        <li
                          key={label}
                          className="flex items-center gap-2 text-sm text-destructive"
                        >
                          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-destructive" />
                          {label}
                        </li>
                      ))}
                    </ul>
                  </PopoverContent>
                </Popover>
                {scheduleEnabled && (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={isSaving}
                    onClick={handleScheduleClick}
                    className={cn(
                      !isFormValid && '!bg-muted !text-muted-foreground/40 hover:!bg-muted',
                    )}
                  >
                    <CalendarClock className="mr-1.5 h-4 w-4" />
                    Schedule
                  </Button>
                )}
                {uploadsPending && (
                  <span className="text-xs text-muted-foreground">Attachments uploading…</span>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Posted-edit notice banner */}
      {isPostedEdit && (
        <div className="border-b bg-muted px-6 py-3">
          <p className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <Lock className="h-3.5 w-3.5 shrink-0" />
            <span>
              This post has been sent. Only{' '}
              <span className="font-medium text-foreground">Staff-in-charge</span>
              {', '}
              <span className="font-medium text-foreground">Enquiry email</span>
              {', '}
              <span className="font-medium text-foreground">Due date</span>
              {' and '}
              <span className="font-medium text-foreground">Reminder</span> can be changed.
            </span>
          </p>
        </div>
      )}

      {/* Failed-scheduled error banner */}
      {isFailedScheduledEdit && (
        <div className="border-b border-destructive/20 bg-destructive/5 px-6 py-3">
          <p className="flex items-center gap-2 text-sm text-destructive">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            <span>
              <span className="font-medium">Scheduled send failed.</span> {failedScheduledReason}{' '}
              Edit your post and reschedule to try again.
            </span>
          </p>
        </div>
      )}

      {/* Body */}
      <div className="flex justify-center gap-8 px-6 py-6">
        <div className="flex w-full max-w-2xl flex-1 flex-col gap-6">
          {/* 30-day media retention banner — dismissable per entry. The API
              doesn't expose upload timestamps, so no per-file countdown. */}
          {!fileBannerDismissed && isEditing && !isPostedEdit && draftMediaLabel && (
            <div className="flex items-start gap-3 rounded-xl border border-amber-6 bg-amber-3 px-4 py-3 text-xs">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-11" />
              <div className="flex-1">
                <p className="font-semibold text-amber-12">
                  {draftMediaLabel} from this draft expire 30 days after upload
                </p>
                <p className="mt-0.5 text-amber-11">
                  Files and photos are retained for 30 days from upload. Re-upload them before
                  posting to avoid losing them.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setFileBannerDismissed(true)}
                className="shrink-0 rounded p-0.5 text-amber-11 hover:bg-amber-4 hover:text-amber-12"
                aria-label="Dismiss"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}

          {/* RECIPIENTS Card — overflow-visible so selector dropdowns aren't
              clipped by the card's rounded-corner overflow trap */}
          <Card className="overflow-visible">
            <CardContent className="space-y-5 p-6">
              <p className="text-xs font-medium tracking-widest text-muted-foreground uppercase">
                Recipients
              </p>

              {/* Students field */}
              <div className={isPostedEdit ? 'pointer-events-none opacity-50 select-none' : ''}>
                <div className="space-y-1.5">
                  <Label>
                    Students <span className="text-destructive">*</span>
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    Parents of the selected students will receive this post via Parents Gateway.
                  </p>
                  <StudentRecipientSelector
                    classes={classes}
                    students={students}
                    value={toSelectorEntities(state.selectedRecipients)}
                    onChange={(next) => {
                      clearFieldError('recipients');
                      dispatch({ type: 'SET_RECIPIENTS', payload: next });
                    }}
                  />
                  {fieldErrors.recipients && (
                    <p role="alert" className="text-sm text-destructive">
                      {fieldErrors.recipients}
                    </p>
                  )}
                </div>
              </div>

              <Separator />

              {/* Enquiry email */}
              <div className="space-y-1.5">
                <Label>
                  Enquiry email <span className="text-destructive">*</span>
                </Label>
                <p className="text-sm text-muted-foreground">
                  Parents’ enquiries go to this email address.
                </p>
                <EnquiryEmailSelector
                  emailOptions={emailOptions}
                  value={state.enquiryEmail ?? ''}
                  onChange={(email) => {
                    clearFieldError('enquiryEmail');
                    dispatch({ type: 'SET_EMAIL', payload: email });
                  }}
                  aria-invalid={fieldErrors.enquiryEmail ? true : undefined}
                />
                {fieldErrors.enquiryEmail && (
                  <p role="alert" className="text-sm text-destructive">
                    {fieldErrors.enquiryEmail}
                  </p>
                )}
              </div>

              <Separator />

              {/* Staff in charge */}
              <div className="space-y-1.5">
                <Label>
                  Staff-in-charge{' '}
                  <span className="text-xs font-normal text-muted-foreground">(optional)</span>
                </Label>
                <p className="text-sm text-muted-foreground">
                  These staff will be able to view read status, and delete this post.
                </p>
                <StaffSearchSelector
                  staff={staff}
                  value={toSelectorEntities(state.selectedStaff)}
                  onChange={(next) => dispatch({ type: 'SET_STAFF', payload: next })}
                />
              </div>
            </CardContent>
          </Card>

          <div className={isPostedEdit ? 'pointer-events-none opacity-50 select-none' : 'contents'}>
            {/* CONTENT Card */}
            <Card>
              <CardContent className="space-y-5 p-6">
                <p className="text-xs font-medium tracking-widest text-muted-foreground uppercase">
                  Content
                </p>

                {/* Title */}
                <div className="space-y-1.5" onFocus={() => setFocusSection('header')}>
                  <div className="flex items-center justify-between">
                    <Label htmlFor="post-title">
                      Title <span className="text-destructive">*</span>
                    </Label>
                    <span
                      className={cn(
                        'text-xs tabular-nums',
                        state.title.length > TITLE_MAX_LENGTH
                          ? 'text-destructive'
                          : 'text-muted-foreground',
                      )}
                    >
                      {state.title.length}/{TITLE_MAX_LENGTH}
                    </span>
                  </div>
                  <Input
                    id="post-title"
                    value={state.title}
                    aria-invalid={
                      fieldErrors.title || state.title.length > TITLE_MAX_LENGTH ? true : undefined
                    }
                    onChange={(e) => {
                      clearFieldError('title');
                      dispatch({ type: 'SET_TITLE', payload: e.target.value });
                    }}
                  />
                  {state.title.length > TITLE_MAX_LENGTH && (
                    <p role="alert" className="text-sm text-destructive">
                      Exceeded by {state.title.length - TITLE_MAX_LENGTH} characters.
                    </p>
                  )}
                  {fieldErrors.title && state.title.length <= TITLE_MAX_LENGTH && (
                    <p role="alert" className="text-sm text-destructive">
                      {fieldErrors.title}
                    </p>
                  )}
                </div>

                <Separator />

                {/* Description */}
                <div className="space-y-1.5" onFocus={() => setFocusSection('content')}>
                  <div className="flex items-center justify-between">
                    <Label id="post-description-label">
                      Description <span className="text-destructive">*</span>
                    </Label>
                    <span
                      className={cn(
                        'text-xs tabular-nums',
                        state.description.length > DESCRIPTION_MAX_LENGTH
                          ? 'text-destructive'
                          : 'text-muted-foreground',
                      )}
                    >
                      {state.description.length}/{DESCRIPTION_MAX_LENGTH}
                    </span>
                  </div>
                  <RichTextEditor
                    initialContent={initialDescriptionDoc}
                    maxLength={DESCRIPTION_MAX_LENGTH}
                    placeholder="Write your announcement here. Use the toolbar to format text and insert inline links."
                    ariaLabelledBy="post-description-label"
                    onChange={(doc, text) => {
                      clearFieldError('description');
                      dispatch({ type: 'SET_DESCRIPTION_DOC', payload: { doc, text } });
                    }}
                  />
                  {state.description.length > DESCRIPTION_MAX_LENGTH && (
                    <p role="alert" className="text-sm text-destructive">
                      Exceeded by {state.description.length - DESCRIPTION_MAX_LENGTH} characters.
                    </p>
                  )}
                  {fieldErrors.description &&
                    state.description.length <= DESCRIPTION_MAX_LENGTH && (
                      <p role="alert" className="text-sm text-destructive">
                        {fieldErrors.description}
                      </p>
                    )}
                </div>

                {selectedType === 'post-with-response' && (
                  <>
                    <Separator />
                    <div className="space-y-5" onFocus={() => setFocusSection('header')}>
                      <EventScheduleSection
                        value={state.event}
                        onChange={(value) => dispatch({ type: 'SET_EVENT', payload: value })}
                      />
                      <VenueSection
                        value={state.venue}
                        onChange={(value) => dispatch({ type: 'SET_VENUE', payload: value })}
                      />
                    </div>
                  </>
                )}

                <Separator />

                <ShortcutsSection
                  value={state.shortcuts}
                  onChange={(next) => dispatch({ type: 'SET_SHORTCUTS', payload: next })}
                  declareTravelsEnabled={declareTravelsEnabled}
                  editContactEnabled={editContactEnabled}
                />

                <Separator />

                <div onFocus={() => setFocusSection('links')}>
                  <WebsiteLinksSection value={state.websiteLinks} dispatch={dispatch} />
                </div>

                <Separator />

                <div onFocus={() => setFocusSection('attachments')}>
                  <AttachmentSection
                    files={state.attachments}
                    photos={state.photos}
                    dispatch={dispatch}
                    kind={state.kind === 'announcement' ? 'ANNOUNCEMENT' : 'CONSENT_FORM'}
                  />
                </div>
              </CardContent>
            </Card>

            {/* RESPONSE TYPE Card */}
            {selectedType === 'post-with-response' && (
              <Card>
                <CardContent className="space-y-5 p-6">
                  <div className="space-y-1">
                    <p className="text-xs font-medium tracking-widest text-muted-foreground uppercase">
                      Response Type
                    </p>
                    <p className="text-sm text-muted-foreground">
                      Choose how parents respond to this post.
                    </p>
                  </div>

                  <div onFocus={() => setFocusSection('response')}>
                    <ResponseTypeSelector
                      value={state.responseType}
                      onChange={(value) => dispatch({ type: 'SET_RESPONSE_TYPE', payload: value })}
                      hideViewOnly
                    />
                  </div>

                  {state.responseType === 'yes-no' && (
                    <>
                      <Separator />
                      <div className="space-y-4">
                        <div className="flex items-start justify-between gap-4">
                          <div className="space-y-1">
                            <p className="text-xs font-medium tracking-widest text-muted-foreground uppercase">
                              Questions
                            </p>
                            <p className="text-sm text-muted-foreground">
                              Custom questions (optional). You may add up to {MAX_QUESTIONS}{' '}
                              questions.
                            </p>
                          </div>
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={state.questions.length >= MAX_QUESTIONS}
                            onClick={() => {
                              dispatch({ type: 'ADD_QUESTION' });
                              setFocusSection('questions');
                            }}
                          >
                            <Plus className="h-4 w-4" />
                            Add a Question
                          </Button>
                        </div>
                        <QuestionBuilder
                          questions={state.questions}
                          dispatch={dispatch}
                          onQuestionFocus={(index) => {
                            setFocusedQuestionIndex(index);
                            setFocusSection('questions');
                          }}
                        />
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>
            )}
          </div>
          {/* end locked-for-posted-edit */}

          {/* SETTINGS Card (due date + reminders) */}
          {selectedType === 'post-with-response' &&
            (state.responseType === 'acknowledge' || state.responseType === 'yes-no') && (
              <Card>
                <CardContent className="space-y-5 p-6">
                  <p className="text-xs font-medium tracking-widest text-muted-foreground uppercase">
                    Settings
                  </p>

                  <div onFocus={() => setFocusSection('response')}>
                    <DueDateSection
                      value={state.dueDate}
                      onChange={(value) => {
                        clearFieldError('dueDate');
                        dispatch({ type: 'SET_DUE_DATE', payload: value });
                      }}
                      required
                    />
                    {fieldErrors.dueDate && (
                      <p role="alert" className="mt-1.5 text-sm text-destructive">
                        {fieldErrors.dueDate}
                      </p>
                    )}
                  </div>

                  <Separator />

                  <ReminderSection
                    value={state.reminder}
                    onChange={(value) => dispatch({ type: 'SET_REMINDER', payload: value })}
                    consentByDate={state.dueDate}
                  />
                </CardContent>
              </Card>
            )}
        </div>

        {showPreview && (
          <div className="sticky top-[72px] hidden h-fit w-[360px] shrink-0 lg:block">
            <Card>
              <CardContent className="space-y-4 p-5">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-medium tracking-widest text-muted-foreground uppercase">
                    Preview
                  </p>
                  <p className="text-xs text-muted-foreground">As seen by parents</p>
                </div>
                <PostPreview
                  formState={deferredState}
                  currentUserName={stripSalutation(session.staffName ?? 'Daniel Tan')}
                  defaultEnquiryEmail={session.schoolEmailAddress ?? 'enquiry@school.edu.sg'}
                  focusSection={focusSection}
                  focusQuestionIndex={focusedQuestionIndex}
                  onDismissQuestions={() => setFocusSection('response')}
                />
              </CardContent>
            </Card>
          </div>
        )}
      </div>

      {/* Mobile preview */}
      <div
        className={cn(
          'fixed inset-0 z-50 transition-opacity duration-150 lg:hidden',
          showPreview ? 'pointer-events-auto bg-black/50' : 'pointer-events-none bg-transparent',
        )}
        onClick={() => setShowPreview(false)}
      >
        <div
          className={cn(
            'absolute top-0 right-0 bottom-0 w-[360px] overflow-y-auto bg-white p-4 shadow-xl transition-transform duration-150',
            showPreview ? 'translate-x-0' : 'translate-x-full',
          )}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="mb-4 flex items-center justify-between">
            <p className="text-sm font-medium">Preview</p>
            <Button variant="ghost" size="sm" onClick={() => setShowPreview(false)}>
              Close
            </Button>
          </div>
          <PostPreview
            formState={deferredState}
            currentUserName={stripSalutation(session.staffName ?? 'Daniel Tan')}
            defaultEnquiryEmail={session.schoolEmailAddress ?? 'enquiry@school.edu.sg'}
          />
        </div>
      </div>

      {/* Schedule step 1 — pick the release date and time. */}
      <SchedulePickerDialog
        open={showScheduleDialog}
        onOpenChange={setShowScheduleDialog}
        onConfirm={handleScheduleContinue}
        busy={isSaving}
        scheduleWindow={scheduleWindow}
        dueDate={selectedType === 'post-with-response' ? state.dueDate : undefined}
      />

      {/* Schedule step 2 (and the Post-now confirm) — review, then send.
          Closing the scheduled summary steps back to the picker with the
          chosen date and time retained. */}
      <SendConfirmationDialog
        open={showSendDialog}
        onOpenChange={(next) => {
          setShowSendDialog(next);
          if (!next && pendingScheduledAt) setShowScheduleDialog(true);
        }}
        title={state.title}
        recipientGroups={recipientGroups}
        totalRecipients={recipientCount}
        scheduledAt={pendingScheduledAt ?? undefined}
        responseType={state.responseType}
        dueDate={selectedType === 'post-with-response' ? state.dueDate : undefined}
        busy={isSaving}
        onConfirm={() => {
          if (pendingScheduledAt) {
            void handleScheduleConfirm(pendingScheduledAt);
          } else {
            void handleSendConfirm();
          }
        }}
      />
    </div>
  );
}

// ─── Route component ─────────────────────────────────────────────────────────

interface CreatePostPageProps {
  postKind: 'announcement' | 'form';
  draft: boolean;
}

function CreatePostPage({ postKind, draft }: CreatePostPageProps) {
  const { id } = useParams();
  return <CreatePostPageInner key={id ?? 'new'} editId={id} postKind={postKind} draft={draft} />;
}

export { CreatePostPage };

// ─── SaveStatusTicker ────────────────────────────────────────────────────────

function SaveStatusTicker({
  status,
  lastSavedAt,
}: {
  status: AutoSaveStatus;
  lastSavedAt: Date | null;
}) {
  let label: string;
  if (status === 'saving') label = 'Saving…';
  else if (status === 'error') label = 'Save failed';
  else if (lastSavedAt) {
    label = `Saved ${lastSavedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  } else label = '';

  return (
    <span className="text-xs text-muted-foreground tabular-nums" aria-live="polite">
      {label}
    </span>
  );
}
