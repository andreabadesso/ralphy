import { Header } from "@/components/header";
import { Hero } from "@/components/hero";
import { Features } from "@/components/features";
import { Engines } from "@/components/engines";
import { Quickstart } from "@/components/quickstart";
import { Footer } from "@/components/footer";

export default function Home() {
  return (
    <main>
      <Header />
      <Hero />
      <Features />
      <Engines />
      <Quickstart />
      <Footer />
    </main>
  );
}
