# Übersetzt das Werkzeug. Wer make nicht hat, nimmt den Befehl aus der
# README — es ist derselbe, nur von Hand.

CXX      ?= g++
CXXFLAGS ?= -std=c++17 -Wall -Wextra -O2
ZIEL     ?= codebox

$(ZIEL): src/main.cpp
	$(CXX) $(CXXFLAGS) src/main.cpp -o $(ZIEL)

# Unter Windows statisch binden: sonst sucht codebox.exe beim Start die DLLs
# aus C:\msys64\ucrt64\bin und laeuft nur im MSYS2-Fenster.
windows:
	$(CXX) $(CXXFLAGS) -static src/main.cpp -o codebox.exe

.PHONY: sauber installieren windows
sauber:
	rm -f $(ZIEL) $(ZIEL).exe

# Legt das Programm dorthin, wo das System nach Befehlen sucht.
installieren: $(ZIEL)
	mkdir -p $(HOME)/.local/bin
	cp $(ZIEL) $(HOME)/.local/bin/
	@echo "Nach $(HOME)/.local/bin kopiert."
	@echo "Steht der Ordner nicht im PATH, diese Zeile in ~/.bashrc oder ~/.zshrc:"
	@echo '  export PATH="$$HOME/.local/bin:$$PATH"'
