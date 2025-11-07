import mongoose from "mongoose";

let connectPromise: Promise<typeof mongoose> | null = null;

export async function connectToDatabase(): Promise<typeof mongoose> {
  if (mongoose.connection.readyState === 1) {
    return mongoose;
  }

  if (connectPromise) {
    return connectPromise;
  }

  const mongoUri = process.env.MONGODB_URI;

  if (!mongoUri) {
    throw new Error("MONGODB_URI environment variable is not defined");
  }

  connectPromise = mongoose.connect(mongoUri, {
    autoIndex: true,
    autoCreate: true,
    serverSelectionTimeoutMS: 20000,
    socketTimeoutMS: 45000,
  });

  try {
    await connectPromise;
    return mongoose;
  } catch (error) {
    connectPromise = null;
    throw error;
  }
}

export function isDatabaseConnected(): boolean {
  return mongoose.connection.readyState === 1;
}


