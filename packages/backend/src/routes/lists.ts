import express, { Request, Response } from 'express';
import List from '../models/List';
import { authMiddleware } from '../middleware/auth';

const router = express.Router();

// Apply authentication middleware to all routes
router.use('/', authMiddleware);

// Create a new list
router.post('/', async (req: Request, res: Response) => {
  try {
    const newList = new List(req.body);
    const savedList = await newList.save();
    res.status(201).json(savedList);
  } catch (error) {
    if (error instanceof Error) {
      res.status(400).json({ message: error.message });
    } else {
      res.status(400).json({ message: 'An unknown error occurred' });
    }
  }
});

// Get all lists
router.get('/', async (req: Request, res: Response) => {
  try {
    const lists = await List.find();
    res.status(200).json(lists);
  } catch (error) {
    if (error instanceof Error) {
      res.status(400).json({ message: error.message });
    } else {
      res.status(400).json({ message: 'An unknown error occurred' });
    }
  }
});

// Get a single list by ID
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const list = await List.findById(req.params.id);
    if (!list) return res.status(404).json({ message: 'List not found' });
    res.status(200).json(list);
  } catch (error) {
    if (error instanceof Error) {
      res.status(400).json({ message: error.message });
    } else {
      res.status(400).json({ message: 'An unknown error occurred' });
    }
  }
});

// Update a list by ID
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const updatedList = await List.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!updatedList) return res.status(404).json({ message: 'List not found' });
    res.status(200).json(updatedList);
  } catch (error) {
    if (error instanceof Error) {
      res.status(400).json({ message: error.message });
    } else {
      res.status(400).json({ message: 'An unknown error occurred' });
    }
  }
});

// Delete a list by ID
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const deletedList = await List.findByIdAndDelete(req.params.id);
    if (!deletedList) return res.status(404).json({ message: 'List not found' });
    res.status(200).json({ message: 'List deleted' });
  } catch (error) {
    if (error instanceof Error) {
      res.status(400).json({ message: error.message });
    } else {
      res.status(400).json({ message: 'An unknown error occurred' });
    }
  }
});

export default router;
