import mongoose from 'mongoose';

const { Schema } = mongoose;

export const RepositoryCheck = mongoose.model('RepositoryCheck', new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
  repositoryUrl: { type: String, required: true },
  providerStatus: { type: String, enum: ['public','not_found_or_private'], required: true },
  fullName: String,
  description: String,
  defaultBranch: String,
  pushedAt: Date,
  archived: Boolean,
  stars: Number,
  checkedAt: { type: Date, default: Date.now },
}, { timestamps: true }));
