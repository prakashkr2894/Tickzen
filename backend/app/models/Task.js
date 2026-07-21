import mongoose from 'mongoose';

const taskSchema = new mongoose.Schema({
  title: {
    type: String,
    required: [true, 'Task title is required'],
    trim: true
  },
  description: {
    type: String,
    trim: true,
    default: ''
  },
  projectId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Project',
    required: true
  },
  panelId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Panel'
  },
  order: {
    type: Number,
    default: 0
  },
  assignedDeveloper: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  status: {
    type: String,
    enum: ['pending', 'in-progress', 'review', 'completed'],
    default: 'pending'
  },
  priority: {
    type: String,
    enum: ['low', 'medium', 'high', 'urgent'],
    default: 'medium'
  },
  attachmentFile: {
    filename: String,
    originalName: String,
    path: String,
    mimetype: String,
    size: Number
  },
  attachments: [{
    filename: String,
    originalName: String,
    path: String,
    mimetype: String,
    size: Number,
    uploadedAt: {
      type: Date,
      default: Date.now
    }
  }],
  comments: [{
    content: {
      type: String,
      required: true,
      trim: true
    },
    author: {
      _id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
      },
      name: {
        type: String,
        required: true
      },
      email: {
        type: String,
        required: true
      },
      role: {
        type: String,
        enum: ['admin', 'developer'],
        required: true
      }
    },
    createdAt: {
      type: Date,
      default: Date.now
    },
    updatedAt: {
      type: Date,
      default: Date.now
    }
  }],
  deadline: {
    type: Date
  },
  completedByDeveloper: {
    type: Boolean,
    default: false
  },
  completedAt: {
    type: Date
  },
  approvedByAdmin: {
    type: Boolean,
    default: false
  },
  approvedAt: {
    type: Date
  }
}, {
  timestamps: true
});

// Compound indexes for the most frequent query patterns
taskSchema.index({ projectId: 1, status: 1 });
taskSchema.index({ assignedDeveloper: 1, status: 1 });
taskSchema.index({ panelId: 1, order: 1 });

const Task = mongoose.model('Task', taskSchema);

export default Task;
