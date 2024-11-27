import { useRouter } from "next/navigation";
import { useState, useEffect } from "react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { HamburgerButton } from "@/components/elements/hamburger-button";
import { Header } from "@/features/header";

const ContributePage = () => {
  const router = useRouter();
  const [stats, setStats] = useState({ feedback: 0, features: 0, bugs: 0 });

  useEffect(() => {
    // Fetch the stats from an API or service
    fetch("/api/contribution-stats")
      .then(
        (response) =>
          response.json() as Promise<{
            feedback: number;
            features: number;
            bugs: number;
          }>,
      )
      .then((data) => setStats(data));
  }, []);

  const handleContribute = () => {
    router.push("/contribute-form");
  };

  return (
    <div className="container mx-auto p-4">
      <Header>
        <HamburgerButton />
        <h1 className="mt-4 text-3xl font-bold">
          Contribute to Mention by Oxy
        </h1>
      </Header>
      <Accordion type="single" collapsible className="my-4 w-full">
        <AccordionItem value="item-1">
          <AccordionTrigger>Why Contribute?</AccordionTrigger>
          <AccordionContent>
            Contributing to Mention by Oxy helps us improve our services and
            provide better features for all users.
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="item-2">
          <AccordionTrigger>How Can I Contribute?</AccordionTrigger>
          <AccordionContent>
            You can contribute by providing feedback, suggesting new features,
            or reporting bugs. We value your input!
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="item-3">
          <AccordionTrigger>What Are the Benefits?</AccordionTrigger>
          <AccordionContent>
            Contributors get early access to new features, recognition in our
            community, and other exclusive perks.
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="item-4">
          <AccordionTrigger>Contribution Guidelines</AccordionTrigger>
          <AccordionContent>
            Please follow our contribution guidelines to ensure a smooth and
            effective collaboration. Visit our guidelines page for more details.
          </AccordionContent>
        </AccordionItem>
      </Accordion>
      <div className="features-list my-4">
        <h2 className="text-2xl font-semibold">Ways to Contribute</h2>
        <ul className="ml-4 list-inside list-disc">
          <li>Provide feedback</li>
          <li>Suggest new features</li>
          <li>Report bugs</li>
          <li>Participate in beta testing</li>
          <li>Share your use cases</li>
        </ul>
      </div>
      <div className="contribution-stats my-4">
        <h2 className="text-2xl font-semibold">Current Contributions</h2>
        <ul className="ml-4 list-inside list-disc">
          <li>Feedback provided: {stats.feedback}</li>
          <li>Features suggested: {stats.features}</li>
          <li>Bugs reported: {stats.bugs}</li>
        </ul>
      </div>
      <div className="cta-button my-4">
        <button
          className="btn-primary rounded bg-blue-500 px-4 py-2 text-white hover:bg-blue-700"
          onClick={handleContribute}
        >
          Contribute Now
        </button>
      </div>
    </div>
  );
};

export default ContributePage;

export const metadata = {
  title: "Contribute to Mention by Oxy",
};
