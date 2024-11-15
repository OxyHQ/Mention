"use client";
import axios from "axios";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale } from "@/app/LocaleContext";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Tooltip } from "@/components/elements/tooltip";
import { BackArrowIcon } from "@/assets/back-arrow-icon";
import { Button } from "@/components/elements/button";
import { Header } from "@/features/header";
import { toast } from "sonner";

export const FeedbackClientPage = () => {
  const { t } = useLocale();
  const router = useRouter();
  const [feedback, setFeedback] = useState("");

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      // Send the feedback to the server
      await axios.post("/api/feedback", { feedback });
      // Reset the feedback input
      setFeedback("");
      // Show a success message
      toast("Feedback submitted successfully");
    } catch (error) {
      // Handle any errors
      console.error("Error submitting feedback:", error);
      // Show an error message
      toast("Failed to submit feedback.");
    }
  };

  const handleChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    setFeedback(event.target.value);
  };

  return (
    <div>
      <Header>
        <Tooltip text="Back">
          <Button
            onClick={() => {
              router.back();
            }}
            aria-label="Back"
            className="hover:bg-neutral-500 focus-visible:bg-neutral-500 focus-visible:outline-secondary-100 active:bg-neutral-600"
          >
            <BackArrowIcon />
          </Button>
        </Tooltip>
        <h2>{t("pages.feedback.title")}</h2>
      </Header>
      <div className="container mx-auto px-4">
        <Accordion type="single" collapsible className="w-full">
          <AccordionItem value="item-1">
            <AccordionTrigger>
              {t("pages.feedback.faq.items.question1.title")}
            </AccordionTrigger>
            <AccordionContent>
              {t("pages.feedback.faq.items.question1.answer")}
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="item-2">
            <AccordionTrigger>
              {t("pages.feedback.faq.items.question2.title")}
            </AccordionTrigger>
            <AccordionContent>
              {t("pages.feedback.faq.items.question2.answer")}
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="item-3">
            <AccordionTrigger>
              {t("pages.feedback.faq.items.question3.title")}
            </AccordionTrigger>
            <AccordionContent>
              {t("pages.feedback.faq.items.question3.answer")}
            </AccordionContent>
          </AccordionItem>
        </Accordion>
        <form onSubmit={handleSubmit} className="mt-4">
          <label className="mb-2 block">
            {t("pages.feedback.title")}:
            <textarea
              value={feedback}
              onChange={handleChange}
              className="w-full rounded-md border border-gray-300 p-2"
              rows={4}
            />
          </label>
          <Button type="submit" className="bg-primary-100 text-white">
            {t("common.send")}
          </Button>
        </form>
      </div>
    </div>
  );
};
