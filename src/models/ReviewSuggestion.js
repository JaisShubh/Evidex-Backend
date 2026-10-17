import mongoose from 'mongoose';

const { Schema } = mongoose;

export const ReviewSuggestion = mongoose.model('ReviewSuggestion', new Schema({
  submissionId: { type: Schema.Types.ObjectId, ref: 'Submission', required: true, index: true },
  reviewerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  source: { type: String, enum: ['gemini','sample'], required: true },
  model: { type: String, default: null },
  promptVersion: { type: String, default: '1' },
  scores: [{ criterion: { type: String, required: true }, score: { type: Number, required: true, min: 0 }, maxScore: { type: Number, required: true, min: 0 }, rationale: { type: String, required: true } }],
  summary: { type: String, required: true, maxlength: 2000 },
  notice: { type: String, required: true, maxlength: 500 },
}, { timestamps: true }));
