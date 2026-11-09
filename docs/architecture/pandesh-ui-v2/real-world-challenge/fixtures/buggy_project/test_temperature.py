import unittest
from temperature import celsius_to_fahrenheit


class TestTemperature(unittest.TestCase):
    def test_freezing(self):
        self.assertEqual(celsius_to_fahrenheit(0), 32)

    def test_boiling(self):
        self.assertEqual(celsius_to_fahrenheit(100), 212)


if __name__ == "__main__":
    unittest.main()
