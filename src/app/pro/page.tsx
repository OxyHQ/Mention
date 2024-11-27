import { useRouter } from "next/navigation";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { HamburgerButton } from "@/components/elements/hamburger-button";
import { Header } from "@/features/header";

const ProPage = () => {
  const router = useRouter();

  const handleSubscribe = () => {
    router.push("/subscription");
  };

  return (
    <div>
      <Header>
        <HamburgerButton />
        <h1>Mention Pro by Oxy</h1>
      </Header>
      <Accordion type="single" collapsible className="w-full px-4">
        <AccordionItem value="item-1">
          <AccordionTrigger>What is Mention Pro?</AccordionTrigger>
          <AccordionContent>
            Mention Pro by Oxy is a premium subscription service that offers
            advanced features and tools for managing your mentions.
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="item-2">
          <AccordionTrigger>What are the benefits?</AccordionTrigger>
          <AccordionContent>
            With Mention Pro, you get real-time alerts, in-depth analytics, and
            priority support to help you stay on top of your mentions.
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="item-3">
          <AccordionTrigger>How much does it cost?</AccordionTrigger>
          <AccordionContent>
            Mention Pro is available for a monthly subscription fee. Please
            visit our pricing page for more details.
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="item-4">
          <AccordionTrigger>How do I subscribe?</AccordionTrigger>
          <AccordionContent>
            You can subscribe to Mention Pro by visiting our subscription page
            and choosing the plan that best suits your needs.
          </AccordionContent>
        </AccordionItem>
      </Accordion>
      <div className="features-list px-4">
        <h2>Features of Mention Pro</h2>
        <ul>
          <li>Real-time alerts</li>
          <li>In-depth analytics</li>
          <li>Priority support</li>
          <li>Customizable notifications</li>
          <li>Advanced search filters</li>
        </ul>
      </div>
      <div className="cta-button px-4">
        <button className="btn-primary" onClick={handleSubscribe}>
          Subscribe Now
        </button>
      </div>
    </div>
  );
};

export default ProPage;

export const metadata = {
  title: "Mention Pro by Oxy",
};
