import mongoose, { Document, Schema } from "mongoose";

export interface IPoke extends Document {
  pokerId: string;
  pokedId: string;
  createdAt: Date;
}

const PokeSchema = new Schema({
  pokerId: {
    type: String,
    required: true
  },
  pokedId: {
    type: String,
    required: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// One active poke per user pair
PokeSchema.index({ pokerId: 1, pokedId: 1 }, { unique: true });
// Fetch pokes received by a user
PokeSchema.index({ pokedId: 1, createdAt: -1 });

export default mongoose.model<IPoke>("Poke", PokeSchema);
