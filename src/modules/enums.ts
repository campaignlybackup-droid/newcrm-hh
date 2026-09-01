/** Mirrors the Postgres enums so the UI never invents a value the DB rejects. */
export const WORK_STATUS = ['Not Started','In Progress','Blocked','In Review','Changes Requested','Approved','Scheduled','Delivered','Cancelled'] as const;
export const APPROVAL_STATE = ['Not Required','Draft','Pending','Approved','Changes Requested','Rejected'] as const;
export const APPROVAL_LEVEL = ['Internal','Lead','Manager','Client'] as const;
export const PRIORITY = ['Low','Medium','High','Critical'] as const;
export const HEALTH = ['Green','Amber','Red'] as const;
export const CLIENT_STATUS = ['Lead','Onboarding','Active','Paused','Churned'] as const;
export const LEAD_STAGE = ['New','Contacted','Qualified','Proposal Sent','Negotiation','Won','Lost'] as const;
export const PROJECT_TYPE = ['Retainer','One-off','Campaign'] as const;
export const PROJECT_STATUS = ['Planned','Active','On Hold','Completed','Cancelled'] as const;
export const SHOOT_TYPE = ['Reel','Cinematic','Product','Event','Interview','Photoshoot'] as const;
export const SHOOT_STATUS = ['Tentative','Confirmed','In Progress','Wrapped','Postponed','Cancelled'] as const;
export const PLATFORM = ['Instagram','Facebook','YouTube','LinkedIn','X','Threads','Pinterest','Google','Website','Other'] as const;
export const CONTENT_TYPE = ['Reel','Carousel','Static','Story','Short','Long-form Video','Blog','Newsletter'] as const;
export const CAMPAIGN_OBJECTIVE = ['Awareness','Traffic','Engagement','Leads','App Installs','Conversions','Retention'] as const;
export const MEETING_TYPE = ['Kickoff','Review','Strategy','Internal','Shoot Recce','Training'] as const;
export const ASSET_TYPE = ['Raw Footage','Edit','Image','Design','Document','Audio','Link','Other'] as const;
export const LEAVE_TYPE = ['Casual','Sick','Earned','Unpaid','Comp Off','Holiday'] as const;
export const LEAVE_STATUS = ['Requested','Approved','Rejected','Cancelled'] as const;
export const EMPLOYMENT_TYPE = ['Full-time','Part-time','Intern','Freelancer','Contract','External'] as const;
export const USER_STATUS = ['Invited','Active','On Leave','Suspended','Offboarded'] as const;
export const ACCESS_STATUS = ['Granted','Pending','Not required','Revoked'] as const;
export const ACCESS_SCOPE = ['ALL','SUBTREE','TEAM','OWN','CLIENT_PORTAL','NONE'] as const;

/** Colour keys resolved to CSS classes in components/ui/StatusChip.tsx. */
export const STATUS_TONE: Record<string, 'neutral' | 'info' | 'warn' | 'good' | 'bad'> = {
  'Not Started': 'neutral', 'Draft': 'neutral', 'Tentative': 'neutral', 'Planned': 'neutral',
  'In Progress': 'info', 'In Review': 'info', 'Pending': 'info', 'Confirmed': 'info',
  'Scheduled': 'info', 'Onboarding': 'info', 'Contacted': 'info', 'Qualified': 'info',
  'Blocked': 'bad', 'Changes Requested': 'warn', 'Rejected': 'bad', 'Cancelled': 'neutral',
  'Postponed': 'warn', 'Paused': 'warn', 'On Hold': 'warn', 'Lost': 'bad', 'Churned': 'bad',
  'Approved': 'good', 'Delivered': 'good', 'Wrapped': 'good', 'Completed': 'good',
  'Active': 'good', 'Won': 'good', 'Granted': 'good',
  'Green': 'good', 'Amber': 'warn', 'Red': 'bad',
  'Low': 'neutral', 'Medium': 'info', 'High': 'warn', 'Critical': 'bad',
};
