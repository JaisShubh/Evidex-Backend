import mongoose from 'mongoose';

const profileShareSchema = new mongoose.Schema({
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  tokenHash: { type: String, required: true, unique: true, select: false },
  profileFields: [{ type: String, enum: ['displayName','bio','interests','preferredRole','location','skills'] }],
  projectIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Project' }],
  evidenceIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Evidence' }],
  expiresAt: { type: Date, required: true, index: true },
  revokedAt: { type: Date, default: null },
}, { timestamps: true });

export const ProfileShare = mongoose.model('ProfileShare', profileShareSchema);
