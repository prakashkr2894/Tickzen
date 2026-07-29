import mongoose from 'mongoose';

const projectMeetingSchema = new mongoose.Schema({
  projectId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Project',
    required: true,
    index: true
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  title: {
    type: String,
    required: true,
    trim: true
  },
  scheduledFor: {
    type: Date,
    required: true
  },
  notes: {
    type: String,
    default: '',
    trim: true
  },
  meetingLink: {
    type: String,
    default: '',
    trim: true
  }
}, {
  timestamps: true
});

projectMeetingSchema.index({ projectId: 1, scheduledFor: 1 });

const ProjectMeeting = mongoose.model('ProjectMeeting', projectMeetingSchema);

export default ProjectMeeting;
