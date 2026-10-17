import mongoose from 'mongoose';

const profileSchema = new mongoose.Schema({
  displayName: { type: String, trim: true, maxlength: 80 }, bio: { type: String, trim: true, maxlength: 800, default: '' },
  interests: [{ type: String, trim: true, maxlength: 60 }], preferredRole: { type: String, trim: true, maxlength: 100, default: '' },
  location: { type: String, trim: true, maxlength: 100, default: '' }, visibility: { type: String, enum: ['private','public'], default: 'private' },
  skills: [{ name: { type: String, trim: true }, proficiency: { type: String, enum: ['beginner','intermediate','advanced'], default: 'beginner' }, evidenceIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Evidence' }] }]
}, { timestamps: true });
const accessChangeSchema = new mongoose.Schema({
  changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  source: { type: String, enum: ['bootstrap','admin_api'], required: true },
  previousRole: { type: String, enum: ['student','founder','reviewer','mentor','admin'], required: true },
  role: { type: String, enum: ['student','founder','reviewer','mentor','admin'], required: true },
  previousStatus: { type: String, enum: ['active','suspended'], required: true },
  status: { type: String, enum: ['active','suspended'], required: true },
  changedAt: { type: Date, default: Date.now },
}, { _id: false });
const userSchema = new mongoose.Schema({ name: { type: String, required: true, trim: true, maxlength: 80 }, email: { type: String, required: true, unique: true, lowercase: true, trim: true }, passwordHash: { type: String, required: true }, role: { type: String, enum: ['student','founder','reviewer','mentor','admin'], default: 'student' }, status: { type: String, enum: ['active','suspended'], default: 'active' }, tokenVersion: { type: Number, default: 0, min: 0 }, accessHistory: { type: [accessChangeSchema], default: [] }, profile: { type: profileSchema, default: () => ({}) } }, { timestamps: true });
export const User = mongoose.model('User', userSchema);
