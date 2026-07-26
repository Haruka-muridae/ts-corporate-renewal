import { About } from "@/components/sections/About";
import { Brand } from "@/components/sections/Brand";
import { CTA } from "@/components/sections/CTA";
import { Empathy } from "@/components/sections/Empathy";
import { FAQ } from "@/components/sections/FAQ";
import { Hero } from "@/components/sections/Hero";
import { Pricing } from "@/components/sections/Pricing";
import { Results } from "@/components/sections/Results";
import { Service } from "@/components/sections/Service";
import { HomeJsonLd } from "@/components/seo/HomeJsonLd";
import { lpContent } from "@/content/lp";

export default function HomePage() {
  return (
    <>
      <HomeJsonLd />
      <main>
        <Hero content={lpContent.hero} />
        <Empathy content={lpContent.empathy} />
        <About content={lpContent.about} />
        <Brand content={lpContent.brand} />
        <Service content={lpContent.service} />
        <Results content={lpContent.results} />
        <FAQ content={lpContent.faq} />
        <Pricing content={lpContent.pricing} />
        <CTA content={lpContent.cta} />
      </main>
    </>
  );
}
