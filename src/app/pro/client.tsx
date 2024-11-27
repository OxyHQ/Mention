"use client";
import { useRouter } from "next/navigation";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { HamburgerButton } from "@/components/elements/hamburger-button";
import { Header } from "@/features/header";

export const ProClientPage = () => {
  const router = useRouter();

  const handleSubscribe = () => {
    router.push("/subscription");
  };

  return (
    <div className="min-h-screen bg-gray-100">
      <Header>
        <HamburgerButton />
        <h1 className="text-center text-2xl font-bold">Mention Pro by Oxy</h1>
      </Header>
      <main className="mx-auto max-w-4xl py-8">
        <Accordion type="single" collapsible className="mb-8 w-full px-4">
          <AccordionItem value="item-1">
            <AccordionTrigger className="font-semibold">
              What is Mention Pro?
            </AccordionTrigger>
            <AccordionContent>
              Mention Pro by Oxy is a premium subscription service that offers
              advanced features and tools for managing your mentions.
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="item-2">
            <AccordionTrigger className="font-semibold">
              What are the benefits?
            </AccordionTrigger>
            <AccordionContent>
              With Mention Pro, you get real-time alerts, in-depth analytics,
              and priority support to help you stay on top of your mentions.
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="item-3">
            <AccordionTrigger className="font-semibold">
              How much does it cost?
            </AccordionTrigger>
            <AccordionContent>
              Mention Pro is available for a monthly subscription fee. Please
              visit our pricing page for more details.
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="item-4">
            <AccordionTrigger className="font-semibold">
              How do I subscribe?
            </AccordionTrigger>
            <AccordionContent>
              You can subscribe to Mention Pro by visiting our subscription page
              and choosing the plan that best suits your needs.
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="item-5">
            <AccordionTrigger className="font-semibold">
              Is Mention Pro free for content creators?
            </AccordionTrigger>
            <AccordionContent>
              Yes, Mention Pro is free for content creators who meet the
              following requirements:
              <ul className="mt-2 list-inside list-disc">
                <li>Publish a minimum of 50 posts per month</li>
                <li>Have at least 5K followers or subscribers</li>
                <li>Regularly engage with their audience</li>
                <li>Promote Mention Pro in their content</li>
              </ul>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
        <div className="features-list mb-8 px-4">
          <h2 className="mb-4 text-xl font-semibold">
            Features of Mention Pro
          </h2>
          <ul className="list-inside list-disc">
            <li>Real-time alerts</li>
            <li>In-depth analytics</li>
            <li>Priority support</li>
            <li>Customizable notifications</li>
            <li>Advanced search filters</li>
          </ul>
        </div>
        <div className="cta-button px-4 text-center">
          <button
            className="btn-primary rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
            onClick={handleSubscribe}
          >
            Subscribe Now
          </button>
        </div>
      </main>
    </div>
  );
};
