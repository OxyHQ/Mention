"use client";
import React from "react";
import { PlaceholdersAndVanishInput } from "@/components/ui/placeholders-and-vanish-input";

export const KaanaClientPage = () => {
  const placeholders = [
    "What's the first rule of Fight Club?",
    "Who is Adam Mosseri?",
    "Where is Enric Duran Hiding?",
    "Write a Javascript method to reverse a string",
    "How to assemble your own PC?",
    "How is Nate Isern?",
  ];

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    console.log(e.target.value);
  };
  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    console.log("submitted");
  };
  return (
    <div className="flex flex-col items-center justify-center rounded-[35px] bg-gray-800 px-4 pb-5 pt-20">
      <h2 className="mb-10 text-center text-xl font-bold text-white sm:mb-20 sm:text-5xl">
        Ask Kaana Anything
      </h2>
      <PlaceholdersAndVanishInput
        placeholders={placeholders}
        onChange={handleChange}
        onSubmit={onSubmit}
      />
    </div>
  );
};
