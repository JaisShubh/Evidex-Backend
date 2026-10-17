import mongoose from 'mongoose';

const { Schema } = mongoose;

const briefSchema = new Schema({
  ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  title: { type: String, required: true, trim: true, maxlength: 160 },
  problem: { type: String, required: true, trim: true, maxlength: 4000 },
  desiredOutcome: { type: String, required: true, trim: true, maxlength: 2000 },
  constraints: { type: String, trim: true, maxlength: 2000, default: '' },
  effortEstimate: { type: String, trim: true, maxlength: 200, default: '' },
  requiredSkills: [{ type: String, trim: true, maxlength: 60 }],
  deliverables: [{ name: { type: String, required: true, trim: true, maxlength: 120 }, required: { type: Boolean, default: true }, instructions: { type: String, trim: true, maxlength: 1000, default: '' } }],
  rubric: [{ criterion: { type: String, required: true, trim: true, maxlength: 120 }, points: { type: Number, required: true, min: 1 }, description: { type: String, required: true, trim: true, maxlength: 1000 } }],
  allowedTools: { type: String, trim: true, maxlength: 500, default: 'Any tools; disclose AI assistance.' },
  version: { type: Number, default: 1 },
  status: { type: String, enum: ['draft','published','archived'], default: 'draft' },
  source: { type: String, enum: ['owner','ai'], default: 'owner' },
  draftOrigin: { type: String, enum: ['manual','gemini','sample'], default: 'manual' },
  promptVersion: { type: String, default: null },
  approvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  approvedAt: Date,
  taskId: { type: Schema.Types.ObjectId, ref: 'Task' },
}, { timestamps: true });

export const Brief = mongoose.model('Brief', briefSchema);

const invitationSchema = new Schema({
  briefId: { type: Schema.Types.ObjectId, ref: 'Brief', required: true, index: true },
  taskId: { type: Schema.Types.ObjectId, ref: 'Task', required: true },
  senderId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  recipientId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  briefVersion: { type: Number, required: true },
  message: { type: String, trim: true, maxlength: 1000, default: '' },
  status: { type: String, enum: ['pending','accepted','declined','cancelled'], default: 'pending' },
  consentAt: Date,
  decidedAt: Date,
}, { timestamps: true });
invitationSchema.index({ briefId: 1, recipientId: 1, briefVersion: 1 }, { unique: true });

export const Invitation = mongoose.model('Invitation', invitationSchema);

const swapSchema = new Schema({
  proposerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  recipientId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  offer: { type: String, required: true, trim: true, maxlength: 2000 },
  request: { type: String, required: true, trim: true, maxlength: 2000 },
  terms: { type: String, required: true, trim: true, maxlength: 2000 },
  status: { type: String, enum: ['proposed','accepted','declined','cancelled','completed'], default: 'proposed' },
  confirmations: [{ userId: { type: Schema.Types.ObjectId, ref: 'User', required: true }, confirmedAt: { type: Date, default: Date.now } }],
}, { timestamps: true });

export const ResourceSwap = mongoose.model('ResourceSwap', swapSchema);

const teamSchema = new Schema({
  briefId: { type: Schema.Types.ObjectId, ref: 'Brief', required: true, index: true },
  ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 120 },
  goal: { type: String, required: true, trim: true, maxlength: 1000 },
  requiredSkills: [{ type: String, trim: true, maxlength: 60 }],
  maxMembers: { type: Number, min: 2, max: 8, default: 4 },
  status: { type: String, enum: ['open','closed'], default: 'open' },
  members: [{ userId: { type: Schema.Types.ObjectId, ref: 'User', required: true }, role: { type: String, trim: true, maxlength: 80, default: 'Contributor' }, joinedAt: { type: Date, default: Date.now } }],
}, { timestamps: true });
teamSchema.index({ briefId: 1, ownerId: 1 }, { unique: true });
export const Team = mongoose.model('Team', teamSchema);

const teamInviteSchema = new Schema({
  teamId: { type: Schema.Types.ObjectId, ref: 'Team', required: true, index: true },
  senderId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  recipientId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  teamRole: { type: String, trim: true, maxlength: 80, default: 'Contributor' },
  status: { type: String, enum: ['pending','accepted','declined','cancelled'], default: 'pending' },
  consentAt: Date,
  decidedAt: Date,
}, { timestamps: true });
teamInviteSchema.index({ teamId: 1, recipientId: 1 }, { unique: true });
export const TeamInvitation = mongoose.model('TeamInvitation', teamInviteSchema);
